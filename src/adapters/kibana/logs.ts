import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CallContext, LogQuery, Ports, ReadResult, SourceEvidence } from "../../troubleshooting/application/ports.js";
import type { SimulatorObservation } from "../../troubleshooting/domain/simulator.js";
import type { AuditDetails } from "../../troubleshooting/application/records.js";
import { MAX_ACTIVE_CASES, MAX_LOG_RECORDS, TOOL_CALL_MS } from "../../troubleshooting/application/limits.js";
import { McpBoundary } from "../mcp/boundary.js";
import { McpFailure } from "../mcp/failure.js";
import { canonical, digest, SANITIZATION_VERSION } from "../mcp/manifest.js";
import { validTimestamp } from "../mcp/schema.js";
import { verifyModules, type KibanaProfile } from "./profile.js";
import { businessDate, parseNative } from "./schema.js";
export { loadKibanaProfile } from "./profile.js";
export interface KibanaOptions {
  readonly profile: KibanaProfile;
  readonly resolveIdentifier: (context: CallContext, identifier: string) => string;
  readonly releaseCase?: (caseRef: string) => void;
  readonly approvedCaseResourceRefs?: readonly string[];
}
const incomplete = "Native log completeness is unknown: the source omits ES timeout/shard status and has no stable snapshot.";
const failure = (reason: ConstructorParameters<typeof McpFailure>[0]): never => { throw new McpFailure(reason); };
const exact = (value: object, keys: readonly string[]) => { if (Object.keys(value).some((key) => !keys.includes(key))) failure("invalid_request"); };
export function kibanaLogPorts(ports: Ports, supplied: KibanaOptions, boundary: McpBoundary): Pick<Ports, "logs" | "sanitization"> {
  const profile = structuredClone(supplied.profile), options = { ...supplied };
  const approved = [...(supplied.approvedCaseResourceRefs ?? ["simulator-source"])].sort();
  if (approved.length < 1 || approved.length > 3 || new Set(approved).size !== approved.length || !approved.includes("simulator-source") || approved.some((ref) => !/^[a-z][a-z0-9-]{0,79}$/.test(ref))) failure("contract_unverified");
  const child = fileURLToPath(new URL("./child.js", import.meta.url));
  const endpoint = { command: process.execPath, args: [child, profile.reference.path, profile.reference.sha256], artifact: { path: child, sha256: createHash("sha256").update(readFileSync(child)).digest("hex") } };
  const cases = new Map<string, { rows: number; windows: Set<string>; coverage: number }>();
  boundary.onClear((caseRef) => { options.releaseCase?.(caseRef); cases.delete(caseRef); });
  const authorize = async (context: CallContext) => {
    if (!context.caseRef || !context.callId || !context.approvalRef || !context.policyVersion || !context.snapshotRef || !Number.isSafeInteger(context.phaseId) || context.phaseId < 1 ||
      canonical([...context.resourceRefs].sort()) !== canonical(approved) || !await ports.authorization.allows("mcp.logs.read", { ...context, resourceRefs: ["simulator-source"] })) failure("denied");
  };
  return { sanitization: boundary.sanitization, logs: { read: async (caller, suppliedQuery): Promise<ReadResult<SimulatorObservation | null>> => {
    const query = structuredClone(suppliedQuery);
    const details: AuditDetails = { tool: { name: "read_logs", schemaVersion: "synthetic-kibana-fields-1", artifactVersion: profile.value.profile,
      manifestSha256: digest(profile.value.manifest), sanitizationVersion: SANITIZATION_VERSION },
      scope: { sourceRef: "simulator-source", from: query.from, to: query.to, pageSize: 100 } };
    let context = caller;
    try {
      return await boundary.run({ ...caller, deadline: Math.min(caller.deadline, ports.clock.now() + TOOL_CALL_MS) }, "kibana.logs", endpoint, authorize, async (operation) => {
        context = operation.context;
        exact(query, ["sourceRef", "applicationId", "customerId", "from", "to", "pageSize"]);
        if (query.sourceRef !== "simulator-source" || query.pageSize !== 100 || !!query.applicationId === !!query.customerId || !validTimestamp(query.from) || !validTimestamp(query.to) ||
          Date.parse(query.to) <= Date.parse(query.from) || Date.parse(query.to) - Date.parse(query.from) > 86_400_000) failure("invalid_request");
        // This lossy native contract cannot establish authoritative customer discovery.
        if (query.customerId) failure("contract_unverified");
        let raw: string;
        try { raw = options.resolveIdentifier(context, query.applicationId!); } catch { return failure("denied"); }
        if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > 1024) failure("denied");
        if (!cases.has(context.caseRef)) { if (cases.size >= MAX_ACTIVE_CASES) failure("unavailable"); cases.set(context.caseRef, { rows: 0, windows: new Set(), coverage: 0 }); }
        const tally = cases.get(context.caseRef)!;
        const key = `${query.from}/${query.to}`, span = tally.windows.has(key) ? 0 : Date.parse(query.to) - Date.parse(query.from);
        if (tally.coverage + span > 604_800_000 || tally.rows + 100 > MAX_LOG_RECORDS) failure("budget_exhausted");
        tally.coverage += span; tally.windows.add(key);
        try { await ports.audit.intent(context, "mcp.logs.read", details); } catch { return failure("audit_unavailable"); }
        await verifyModules(profile); operation.current();
        const connected = await operation.connect();
        if (canonical(connected.serverInfo) !== canonical(profile.value.manifest.server) || connected.protocolVersion !== profile.value.manifest.protocolVersion) failure("version_mismatch");
        if (canonical(connected.capabilities) !== canonical(profile.value.manifest.capabilities) || connected.instructions !== undefined) failure("contract_unverified");
        const listed = await operation.listTools();
        if (listed.nextCursor || canonical(listed.tools) !== canonical(profile.value.manifest.tools)) failure("schema_mismatch");
        const evidence: SourceEvidence[] = [], observations: SimulatorObservation[] = [], seen = new Map<string, string>();
        let offset = 0, truncated = false;
        const warnings = [incomplete];
        for (;;) {
          operation.current();
          // Reserve physical page work synchronously BEFORE any await/write. Unknown
          // requests retain all 100 rows; successful validated pages settle to raw count.
          if (tally.rows + 100 > MAX_LOG_RECORDS) { truncated = true; warnings.push("Case raw log row limit reached; further pages were not requested."); break; }
          tally.rows += 100;
          const result = await operation.callTool(profile.value.manifest.searchTool, { index: profile.value.index,
            query: { bool: { filter: [{ term: { application_id: raw } }, { range: { event_time: { gte: query.from, lt: query.to } } }] } },
            size: 100, from: offset, sort: [{ event_time: "asc" }, { event_id: "asc" }] });
          operation.current(); exact(result, ["content", "isError"]);
          if (result.isError) failure("unavailable");
          const content = result.content;
          if (!Array.isArray(content) || content.length !== 1 || content[0]!.type !== "text" || Object.keys(content[0]!).some((key) => !["type", "text"].includes(key))) return failure("schema_mismatch");
          let json: unknown; try { json = JSON.parse(content[0]!.text as string); } catch { return failure("schema_mismatch"); }
          const page = parseNative(json);
          tally.rows -= 100 - page.hits.length;
          const total = typeof page.total === "number" ? page.total : page.total.value;
          if (typeof page.total === "object" && page.total.relation === "gte") { truncated = true; warnings.push("Native total is a lower bound."); }
          for (const hit of page.hits) {
            const row = hit._source;
            if (hit._index !== profile.value.index || row.application_id !== raw || hit._id !== row.event_id || Date.parse(row.event_time) < Date.parse(query.from) || Date.parse(row.event_time) >= Date.parse(query.to) || Date.parse(row.submitted_at) > Date.parse(row.event_time)) failure("denied");
            const signature = canonical(row);
            if (seen.has(row.event_id)) { truncated = true; warnings.push("Duplicate or conflicting native events prevent consistent pagination."); } else seen.set(row.event_id, signature);
            const previous = evidence.at(-1);
            if (previous && (previous.observedAt! > row.event_time || previous.observedAt === row.event_time && previous.locator >= row.event_id)) failure("schema_mismatch");
            const observation: SimulatorObservation = { applicationRef: row.application_id, submittedOn: businessDate(row.submitted_at, row.business_timezone),
              shops: row.submitted_shops.map((shop) => ({ shopRef: shop.shop_id, authorization: shop.authorization, completeThrough: shop.coverage_through, coverageComplete: false })),
              calculation: { started: null, succeeded: null, estimate: null }, causes: [] };
            const safeObservation = operation.sanitize(observation); observations.push(safeObservation);
            const item: SourceEvidence = operation.sanitize({ sourceRef: "simulator-source", kind: "log", locator: row.event_id,
              observedAt: row.event_time, acquiredAt: ports.clock.utc(), completeness: "unknown", truncated: false,
              targetRef: row.application_id, text: `[untrusted native log evidence] ${JSON.stringify(row)}`,
              log: { from: query.from, to: query.to, queryRef: "host-compiled-kibana-1" } });
            evidence.push(item);
          }
          boundary.chargeEvidence(context, operation.sanitize({ value: observations.slice(observations.length - page.hits.length), evidence: evidence.slice(evidence.length - page.hits.length), warnings }));
          offset += page.hits.length;
          if (page.hits.length < 100) { if (offset < total) { truncated = true; warnings.push("Missing native page rows; completeness remains unknown."); } break; }
          if (offset >= total) break;
        }
        const conflict = observations.some((observation) => canonical(observation) !== canonical(observations[0]));
        if (conflict) warnings.push("Conflicting native business observations; no authoritative shop set selected.");
        const result: ReadResult<SimulatorObservation | null> = { value: conflict ? null : observations[0] ?? null, evidence, completeness: "unknown", truncated,
          warnings: operation.sanitize([...new Set(warnings)]) };
        try { await ports.audit.complete(context, "mcp.logs.read", "ok", { ...details, result: { completeness: "unknown", truncated, evidenceCount: evidence.length } }); } catch { return failure("audit_unavailable"); }
        operation.current(); return result;
      });
    } catch (error) {
      const reason = error instanceof McpFailure ? error.reason : "unavailable";
      if (reason !== "audit_unavailable") try { await ports.audit.complete(context, "mcp.logs.read", reason, details); } catch { return failure("audit_unavailable"); }
      return failure(reason);
    }
  } } };
}
