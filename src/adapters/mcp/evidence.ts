import { McpFailure } from "./failure.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { CallContext, LogQuery, Ports, ReadResult, SafeReason } from "../../troubleshooting/application/ports.js";
import type { AuditDetails } from "../../troubleshooting/application/records.js";
import { caseResources } from "../../troubleshooting/application/resource-scope.js";
import { deniedContext, recordDenial } from "../../troubleshooting/application/authorization-audit.js";
import { MAX_ACTIVE_CASES, MAX_INBOUND_BYTES, MAX_LOG_RECORDS } from "../../troubleshooting/application/limits.js";
import { McpBoundary, type OwnedMcpEndpoint } from "./boundary.js";
import { EVIDENCE_SCHEMA, FRAGMENT_BYTES, SANITIZATION_VERSION, canonical, digest, syntheticManifest, type EvidenceManifest } from "./manifest.js";
import { parsePayload, validTimestamp, type Payload } from "./schema.js";

type Endpoint = OwnedMcpEndpoint & { readonly manifest: EvidenceManifest };
export interface McpEvidenceOptions {
  readonly logs: Endpoint;
  readonly code: Endpoint;
  // Host-owned case resolver. It must reject identifiers outside the current case;
  // no model/tool data can install bindings or select endpoints.
  readonly resolveIdentifier: (context: CallContext, identifier: string) => string;
  readonly releaseCase?: (caseRef: string) => void;
  readonly approvedCaseResourceRefs?: readonly string[];
}
const reasonOf = (error: unknown): SafeReason => error instanceof McpFailure ? error.reason : "unavailable";
const exact = (value: object, keys: readonly string[]) => { if (Object.keys(value).some((key) => !keys.includes(key))) throw new McpFailure("invalid_request"); };

export function mcpEvidencePorts(ports: Ports, supplied: McpEvidenceOptions, boundary = new McpBoundary(ports)): Pick<Ports, "logs" | "code" | "sanitization"> {
  const copyEndpoint = ({ close, ...data }: Endpoint): Endpoint => ({ ...structuredClone(data), ...(close ? { close } : {}) });
  const options = { ...supplied, logs: copyEndpoint(supplied.logs), code: copyEndpoint(supplied.code) };
  let approved: readonly string[];
  try { approved = caseResources(supplied.approvedCaseResourceRefs ?? ["simulator-source"]); } catch { throw new McpFailure("contract_unverified"); }
  const cases = new Map<string, { records: number; windows: Set<string>; coverage: number; identifiers: Map<string, string> }>();
  boundary.onClear((caseRef) => {
    cases.get(caseRef)?.identifiers.clear();
    cases.delete(caseRef);
    options.releaseCase?.(caseRef);
  });
  const current = (context: CallContext) => {
    if (context.signal.aborted || ports.retention?.closed()) throw new McpFailure("cancelled");
    if (ports.clock.now() >= context.deadline) throw new McpFailure("timeout");
  };
  const authorize = async (context: CallContext, action: string) => {
    current(context);
    if (!context.caseRef || !Number.isSafeInteger(context.phaseId) || context.phaseId < 1 || !context.callId ||
      !context.policyVersion || !context.approvalRef || canonical([...context.resourceRefs].sort()) !== canonical([...approved].sort()) ||
      !context.snapshotRef || !await ports.authorization.allows(action, { ...context, resourceRefs: ["simulator-source"] })) throw new McpFailure("denied");
    current(context);
  };
  const call = async (context: CallContext, kind: "logs" | "code", query: LogQuery | { readonly repositoryRef: string; readonly snapshotRef: string }): Promise<Payload> => {
    context = Object.freeze({ ...context, resourceRefs: Object.freeze([...context.resourceRefs]) });
    query = structuredClone(query);
    const endpoint = options[kind];
    const action = `mcp.${kind === "logs" ? "logs.read" : "code.search"}`;
    const toolName = kind === "logs" ? "read_logs" : "search_code";
    const details: AuditDetails = { tool: { name: toolName, schemaVersion: endpoint.manifest.schemaVersion,
      artifactVersion: endpoint.manifest.artifactVersion, manifestSha256: digest(endpoint.manifest), sanitizationVersion: SANITIZATION_VERSION },
      scope: kind === "logs" ? { sourceRef: "simulator-source", from: (query as LogQuery).from, to: (query as LogQuery).to, pageSize: 100 }
        : { repositoryRef: "simulator-source", snapshotRef: context.snapshotRef } };
    let auditStage = "none" as "none" | "intent" | "complete";
    try {
      const completed = await boundary.run(context, kind, endpoint, (bound) => authorize(bound, action), async (operation) => {
        context = operation.context;
        const safe = <T>(value: T) => operation.sanitize(value);
        exact(endpoint, ["command", "args", "artifact", "manifest", "close"]);
        if (canonical(endpoint.manifest) !== canonical(syntheticManifest)) throw new McpFailure("contract_unverified");
        let args: Record<string, unknown>;
        if (kind === "logs") {
          const request = query as LogQuery;
          exact(request, ["sourceRef", "applicationId", "customerId", "from", "to", "pageSize"]);
          if (request.sourceRef !== "simulator-source" || request.pageSize !== 100 || !!request.applicationId === !!request.customerId ||
            !validTimestamp(request.from) || !validTimestamp(request.to) ||
            Date.parse(request.to) <= Date.parse(request.from) || Date.parse(request.to) - Date.parse(request.from) > 86_400_000) throw new McpFailure("invalid_request");
          const identifier = request.applicationId ?? request.customerId!;
          let raw: string;
          try { raw = cases.get(context.caseRef)?.identifiers.get(identifier) ?? options.resolveIdentifier(context, identifier); }
          catch { throw new McpFailure("denied"); }
          if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > 1024) throw new McpFailure("denied");
          args = { sourceRef: request.sourceRef, ...(request.applicationId ? { applicationId: raw } : { customerId: raw }), from: request.from, to: request.to, pageSize: 100 };
        } else {
          exact(query, ["repositoryRef", "snapshotRef"]);
          const request = query as { repositoryRef: string; snapshotRef: string };
          if (request.repositoryRef !== "simulator-source" || request.snapshotRef !== context.snapshotRef) throw new McpFailure("denied");
          args = { ...request };
        }
        if (!cases.has(context.caseRef)) {
          if (cases.size >= MAX_ACTIVE_CASES) throw new McpFailure("unavailable");
          cases.set(context.caseRef, { records: 0, windows: new Set(), coverage: 0, identifiers: new Map() });
        }
        const tally = cases.get(context.caseRef)!;
        if (kind === "logs") {
          const from = String(args.from), to = String(args.to), key = `${from}/${to}`;
          const coverage = tally.windows.has(key) ? 0 : Date.parse(to) - Date.parse(from);
          if (tally.records >= MAX_LOG_RECORDS || tally.coverage + coverage > 604_800_000) throw new McpFailure("budget_exhausted");
          tally.windows.add(key); tally.coverage += coverage;
        }
        try { await ports.audit.intent(context, action, details); auditStage = "intent"; } catch { throw new McpFailure("audit_unavailable"); }
        await authorize(context, action);
        if (!isAbsolute(endpoint.command) || !isAbsolute(endpoint.artifact.path) || !/^[a-f0-9]{64}$/.test(endpoint.artifact.sha256) ||
          createHash("sha256").update(await readFile(endpoint.artifact.path)).digest("hex") !== endpoint.artifact.sha256) throw new McpFailure("contract_unverified");
        await authorize(context, action);
        const connected = await operation.connect();
        if (canonical(connected.serverInfo) !== canonical(endpoint.manifest.server) || connected.protocolVersion !== endpoint.manifest.protocolVersion) throw new McpFailure("version_mismatch");
        if (canonical(connected.capabilities) !== canonical({ tools: {} }) || connected.instructions !== undefined) throw new McpFailure("contract_unverified");
        const listed = await operation.listTools();
        if (listed.nextCursor || canonical(listed.tools) !== canonical(endpoint.manifest.tools)) throw new McpFailure("schema_mismatch");
        const pages: Payload[] = [];
        const bindings = new Map<string, string>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          await authorize(context, action);
          const result = await operation.callTool(toolName, { ...args, ...(cursor ? { cursor } : {}) });
          operation.current();
          exact(result, ["content", "structuredContent", "isError"]);
          if (result.isError) throw new McpFailure("unavailable");
          // This reviewed contract has one structured channel. Resources, attachments,
          // arbitrary text/details/meta and dynamic notifications are never forwarded.
          if (!Array.isArray(result.content) || result.content.length !== 0) throw new McpFailure("unsafe_content");
          const source = parsePayload(result.structuredContent);
          if (kind === "logs") {
            const target = args.applicationId ?? args.customerId;
            if (source.evidence.some((item) => item.targetRef !== target)) throw new McpFailure("denied");
            if (source.value && "kind" in source.value) {
              if (!args.customerId || source.value.customerRef !== args.customerId) throw new McpFailure("denied");
              for (const candidate of source.value.candidates) {
                const alias = safe(candidate.applicationId);
                if (Buffer.byteLength(candidate.applicationId) > 1024 || Buffer.byteLength(alias) > 128 || alias === candidate.applicationId ||
                  bindings.has(alias) && bindings.get(alias) !== candidate.applicationId) throw new McpFailure("unsafe_content");
                bindings.set(alias, candidate.applicationId);
              }
            } else if (source.value && source.value.applicationRef !== args.applicationId) throw new McpFailure("denied");
          }
          const page = safe(source);
          for (const item of page.evidence) {
            if (item.sourceRef !== "simulator-source" || item.kind !== (kind === "logs" ? "log" : "code")) throw new McpFailure("denied");
            if (kind === "code" && (!item.code || item.log || item.code.repositoryRef !== "simulator-source" || item.code.snapshotRef !== context.snapshotRef ||
              !/^[a-zA-Z0-9_./-]+:\d+(?:-\d+)?$/.test(item.locator) || item.locator.startsWith("/") || item.locator.includes("..") || item.locator.includes("\\"))) throw new McpFailure("denied");
            if (kind === "logs" && (!item.log || item.code || item.log.from !== args.from || item.log.to !== args.to)) throw new McpFailure("schema_mismatch");
            if (Buffer.byteLength(`[untrusted MCP evidence] ${item.text}`) > FRAGMENT_BYTES) throw new McpFailure("unsafe_content");
          }
          if (page.warnings.some((warning) => Buffer.byteLength(warning) > FRAGMENT_BYTES)) throw new McpFailure("unsafe_content");
          if (kind === "code" && page.value !== null) throw new McpFailure("schema_mismatch");
          if (pages.length && canonical(pages[0]!.value) !== canonical(page.value)) throw new McpFailure("schema_mismatch");
          if (kind === "logs" && tally.records + page.evidence.length > MAX_LOG_RECORDS) throw new McpFailure("budget_exhausted");
          // Conservatively charge the complete sanitized page (observation, metadata,
          // warnings and labels), so alternate structured blocks cannot hide body bytes.
          boundary.chargeEvidence(context, { ...page, evidence: page.evidence.map((item) =>
            ({ ...item, text: `[untrusted MCP evidence] ${item.text}` })) });
          if (kind === "logs") tally.records += page.evidence.length;
          pages.push(page);
          cursor = page.nextCursor;
          if (cursor && (cursors.has(cursor) || pages.length >= 5)) throw new McpFailure("unsafe_content");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        await authorize(context, action);
        const evidence = pages.flatMap((page) => page.evidence.map((item) => ({ ...item, text: `[untrusted MCP evidence] ${item.text}` })));
        const result: Payload = { schemaVersion: EVIDENCE_SCHEMA, value: pages[0]!.value, evidence,
          completeness: pages.some((page) => page.completeness === "unknown" || page.evidence.some((item) => item.completeness === "unknown")) ? "unknown"
            : pages.some((page) => page.completeness === "partial" || page.evidence.some((item) => item.completeness === "partial")) ? "partial" : "complete",
          truncated: pages.some((page) => page.truncated || page.evidence.some((item) => item.truncated)), warnings: pages.flatMap((page) => page.warnings) };
        try { await ports.audit.complete(context, action, "ok", { ...details, result: { completeness: result.completeness, truncated: result.truncated, evidenceCount: evidence.length } }); auditStage = "complete"; }
        catch { throw new McpFailure("audit_unavailable"); }
        await authorize(context, action);
        operation.current();
        return { result, bindings, tally, current: operation.current };
      });
      completed.current();
      const { result, bindings, tally } = completed;
      const combined = new Map([...tally.identifiers, ...bindings]);
      if (combined.size > 100 || [...combined].reduce((sum, [alias, raw]) => sum + Buffer.byteLength(alias) + Buffer.byteLength(raw), 0) > MAX_INBOUND_BYTES ||
        [...bindings].some(([alias, raw]) => tally.identifiers.has(alias) && tally.identifiers.get(alias) !== raw)) throw new McpFailure("unsafe_content");
      for (const [alias, raw] of bindings) tally.identifiers.set(alias, raw);
      return result;
    } catch (error) {
      const reason = reasonOf(error);
      if (reason !== "audit_unavailable") {
        try {
          if (reason === "denied") {
            if (auditStage === "intent") { await ports.audit.complete(context, action, "denied", details); auditStage = "complete"; }
            await recordDenial(ports.audit, deniedContext(context, context.caseRef, ports));
          }
          else await ports.audit.complete(context, action, reason, details);
        } catch { throw new McpFailure("audit_unavailable"); }
      }
      throw new McpFailure(reason);
    }
  };
  return {
    logs: { read: (context, query) => call(context, "logs", query) },
    code: { ...ports.code, search: async (context, query): Promise<ReadResult<null>> => { const result = await call(context, "code", query); return { ...result, value: null }; } },
    sanitization: boundary.sanitization,
  };
}
