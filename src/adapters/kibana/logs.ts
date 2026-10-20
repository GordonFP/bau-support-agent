import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CallContext, LogQuery, Ports, ReadResult, SourceEvidence } from "../../troubleshooting/application/ports.js";
import { pspEvents, type PspObservation } from "../../troubleshooting/domain/psp.js";
import type { SimulatorObservation } from "../../troubleshooting/domain/simulator.js";
import type { AuditDetails } from "../../troubleshooting/application/records.js";
import { caseResources } from "../../troubleshooting/application/resource-scope.js";
import { deniedContext, recordDenial } from "../../troubleshooting/application/authorization-audit.js";
import { MAX_ACTIVE_CASES, MAX_LOG_RECORDS, TOOL_CALL_MS } from "../../troubleshooting/application/limits.js";
import { McpBoundary } from "../mcp/boundary.js";
import { McpFailure } from "../mcp/failure.js";
import { canonical, digest, SANITIZATION_VERSION } from "../mcp/manifest.js";
import { verifyModules, type KibanaProfile } from "./profile.js";
import { businessDate, parseNative, parsePspNative, validLogTimestamp } from "./schema.js";
export { loadKibanaProfile } from "./profile.js";
export interface KibanaOptions {
  readonly sourceRef?: LogQuery["sourceRef"];
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
  let approved: readonly string[];
  try { approved = caseResources(supplied.approvedCaseResourceRefs ?? ["simulator-source"]); } catch { return failure("contract_unverified"); }
  const sourceRef = supplied.sourceRef ?? "simulator-source";
  if (!["simulator-source", "psp-log-source"].includes(sourceRef) || !approved.includes(sourceRef)) failure("contract_unverified");
  if (profile.value.index !== (sourceRef === "psp-log-source" ? "synthetic-psp" : "synthetic-simulator")) failure("contract_unverified");
  const child = fileURLToPath(new URL("./child.js", import.meta.url));
  const endpoint = { command: process.execPath, args: [child, profile.reference.path, profile.reference.sha256], artifact: { path: child, sha256: createHash("sha256").update(readFileSync(child)).digest("hex") } };
  const cases = new Map<string, { rows: number; windows: Set<string>; coverage: number }>();
  boundary.onClear((caseRef) => { options.releaseCase?.(caseRef); cases.delete(caseRef); });
  const authorize = async (context: CallContext) => {
    if (!context.caseRef || !context.callId || !context.approvalRef || !context.policyVersion || !context.snapshotRef || !Number.isSafeInteger(context.phaseId) || context.phaseId < 1 ||
      canonical([...context.resourceRefs].sort()) !== canonical([...approved].sort()) || !await ports.authorization.allows("mcp.logs.read", { ...context, resourceRefs: [sourceRef] })) failure("denied");
  };
  return { sanitization: boundary.sanitization, logs: { read: async (caller, suppliedQuery): Promise<ReadResult<SimulatorObservation | PspObservation | null>> => {
    const query = structuredClone(suppliedQuery);
    const details: AuditDetails = { tool: { name: "read_logs", schemaVersion: sourceRef === "psp-log-source" ? "synthetic-psp-kibana-fields-1" : "synthetic-kibana-fields-1", artifactVersion: profile.value.profile,
      manifestSha256: digest(profile.value.manifest), sanitizationVersion: SANITIZATION_VERSION },
      scope: { sourceRef, from: query.from, to: query.to, pageSize: 100 } };
    let context = caller;
    let auditStage = "none" as "none" | "intent" | "complete";
    try {
      return await boundary.run({ ...caller, deadline: Math.min(caller.deadline, ports.clock.now() + TOOL_CALL_MS) }, "kibana.logs", endpoint, authorize, async (operation) => {
        context = operation.context;
        exact(query, ["sourceRef", "applicationId", "customerId", "shopId", "bindingId", "from", "to", "pageSize"]);
        if (query.sourceRef !== sourceRef || sourceRef === "simulator-source" && (query.shopId !== undefined || query.bindingId !== undefined) || query.pageSize !== 100 || !!query.applicationId === !!query.customerId || !validLogTimestamp(query.from) || !validLogTimestamp(query.to) ||
          Date.parse(query.to) <= Date.parse(query.from) || Date.parse(query.to) - Date.parse(query.from) > 86_400_000) failure("invalid_request");
        // This lossy native contract cannot establish authoritative customer discovery.
        if (query.customerId || sourceRef === "psp-log-source" && (!query.shopId || !query.bindingId)) failure("contract_unverified");
        let raw: string;
        try { raw = options.resolveIdentifier(context, query.applicationId!); } catch { return failure("denied"); }
        if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > 1024) failure("denied");
        const resolve = (identifier: string) => { let raw: string; try { raw = options.resolveIdentifier(context, identifier); } catch { return failure("denied"); }
          if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > 1024) failure("denied"); return raw; };
        const shop = query.shopId ? resolve(query.shopId) : undefined, binding = query.bindingId ? resolve(query.bindingId) : undefined;
        if (!cases.has(context.caseRef)) { if (cases.size >= MAX_ACTIVE_CASES) failure("unavailable"); cases.set(context.caseRef, { rows: 0, windows: new Set(), coverage: 0 }); }
        const tally = cases.get(context.caseRef)!;
        const key = `${query.from}/${query.to}`, span = tally.windows.has(key) ? 0 : Date.parse(query.to) - Date.parse(query.from);
        if (tally.coverage + span > 604_800_000 || tally.rows + 100 > MAX_LOG_RECORDS) failure("budget_exhausted");
        tally.coverage += span; tally.windows.add(key);
        try { await ports.audit.intent(context, "mcp.logs.read", details); auditStage = "intent"; } catch { return failure("audit_unavailable"); }
        await verifyModules(profile); operation.current();
        if (createHash("sha256").update(readFileSync(child)).digest("hex") !== endpoint.artifact.sha256) failure("contract_unverified");
        const connected = await operation.connect();
        if (canonical(connected.serverInfo) !== canonical(profile.value.manifest.server) || connected.protocolVersion !== profile.value.manifest.protocolVersion) failure("version_mismatch");
        if (canonical(connected.capabilities) !== canonical(profile.value.manifest.capabilities) || connected.instructions !== undefined) failure("contract_unverified");
        const listed = await operation.listTools();
        if (listed.nextCursor || canonical(listed.tools) !== canonical(profile.value.manifest.tools)) failure("schema_mismatch");
        const evidence: SourceEvidence[] = [], observations: (SimulatorObservation | PspObservation)[] = [], seen = new Map<string, string>();
        let offset = 0, truncated = false;
        let previousKey: { time: number; id: string } | undefined;
        const warnings = [incomplete];
        for (;;) {
          operation.current();
          // Reserve physical page work synchronously BEFORE any await/write. Unknown
          // requests retain all 100 rows; successful validated pages settle to raw count.
          if (tally.rows + 100 > MAX_LOG_RECORDS) { truncated = true; warnings.push("Case raw log row limit reached; further pages were not requested."); break; }
          tally.rows += 100;
          const result = await operation.callTool(profile.value.manifest.searchTool, { index: profile.value.index,
            query: { bool: { filter: [{ term: { application_id: raw } }, ...(sourceRef === "psp-log-source" ? [{ term: { shop_id: shop } }, { term: { binding_id: binding } }] : []), { range: { event_time: { gte: query.from, lt: query.to } } }] } },
            size: 100, from: offset, sort: [{ event_time: "asc" }, { event_id: "asc" }] });
          operation.current(); exact(result, ["content", "isError"]);
          if (result.isError) failure("unavailable");
          const content = result.content;
          if (!Array.isArray(content) || content.length !== 1 || content[0]!.type !== "text" || Object.keys(content[0]!).some((key) => !["type", "text"].includes(key))) return failure("schema_mismatch");
          let json: unknown; try { json = JSON.parse(content[0]!.text as string); } catch { return failure("schema_mismatch"); }
          const page = sourceRef === "psp-log-source" ? parsePspNative(json) : parseNative(json);
          tally.rows -= 100 - page.hits.length;
          const total = typeof page.total === "number" ? page.total : page.total.value;
          if (typeof page.total === "object" && page.total.relation === "gte") { truncated = true; warnings.push("Native total is a lower bound."); }
          for (const hit of page.hits) {
            const row = hit._source;
            if (hit._index !== profile.value.index || row.application_id !== raw || hit._id !== row.event_id || Date.parse(row.event_time) < Date.parse(query.from) || Date.parse(row.event_time) >= Date.parse(query.to) || ("submitted_at" in row ? Date.parse(row.submitted_at) > Date.parse(row.event_time) : row.shop_id !== shop || row.binding_id !== binding)) failure("denied");
            const signature = canonical(row);
            if (seen.has(row.event_id)) { truncated = true; warnings.push("Duplicate or conflicting native events prevent consistent pagination."); } else seen.set(row.event_id, signature);
            const time = Date.parse(row.event_time);
            if (previousKey && (previousKey.time > time || previousKey.time === time && previousKey.id >= row.event_id)) failure("schema_mismatch");
            previousKey = { time, id: row.event_id };
            const observation: SimulatorObservation | PspObservation = "verification" in row ? row.verification : { applicationRef: row.application_id, submittedOn: businessDate(row.submitted_at, row.business_timezone),
              shops: row.submitted_shops.map((shop) => ({ shopRef: shop.shop_id, authorization: shop.authorization, completeThrough: shop.coverage_through, coverageComplete: false })),
              calculation: { started: null, succeeded: null, estimate: null }, causes: [] };
            const safeObservation = operation.sanitize(observation); observations.push(safeObservation);
            const item: SourceEvidence = operation.sanitize({ sourceRef, kind: "log", locator: row.event_id,
              observedAt: row.event_time, acquiredAt: ports.clock.utc(), completeness: "unknown", truncated: false,
              targetRef: row.application_id, text: `[untrusted native log evidence] ${JSON.stringify("verification" in row ? { event_id: row.event_id, event_time: row.event_time, application_id: row.application_id, shop_id: row.shop_id, binding_id: row.binding_id, point: pspEvents(row.verification).find((event) => event.eventRef === row.event_id && event.observedAt === row.event_time) } : row)}`,
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
        const result: ReadResult<SimulatorObservation | PspObservation | null> = { value: conflict ? null : observations[0] ?? null, evidence, completeness: "unknown", truncated,
          warnings: operation.sanitize([...new Set(warnings)]) };
        try { await ports.audit.complete(context, "mcp.logs.read", "ok", { ...details, result: { completeness: "unknown", truncated, evidenceCount: evidence.length } }); auditStage = "complete"; } catch { return failure("audit_unavailable"); }
        operation.current(); return result;
      });
    } catch (error) {
      const reason = error instanceof McpFailure ? error.reason : "unavailable";
      if (reason !== "audit_unavailable") try {
        if (reason === "denied") {
          if (auditStage === "intent") { await ports.audit.complete(context, "mcp.logs.read", "denied", details); auditStage = "complete"; }
          await recordDenial(ports.audit, deniedContext(context, context.caseRef, ports));
        }
        else await ports.audit.complete(context, "mcp.logs.read", reason, details);
      } catch { return failure("audit_unavailable"); }
      return failure(reason);
    }
  } } };
}
