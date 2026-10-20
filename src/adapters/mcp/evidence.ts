import { McpFailure } from "./failure.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallContext, LogQuery, Ports, ReadResult, SafeReason } from "../../troubleshooting/application/ports.js";
import type { AuditDetails } from "../../troubleshooting/application/records.js";
import { beforeDeadline } from "../../troubleshooting/application/deadline.js";
import { MAX_ACTIVE_CASES, MAX_INBOUND_BYTES, MAX_LOG_RECORDS } from "../../troubleshooting/application/limits.js";
import { BoundedStdio, type StdioEndpoint } from "./stdio.js";
import { CASE_EVIDENCE_BYTES, EVIDENCE_SCHEMA, FRAGMENT_BYTES, SANITIZATION_VERSION, canonical, digest, syntheticManifest, type EvidenceManifest } from "./manifest.js";
import { parsePayload, type Payload } from "./schema.js";

type Endpoint = StdioEndpoint & { readonly manifest: EvidenceManifest };
export interface McpEvidenceOptions {
  readonly logs: Endpoint;
  readonly code: Endpoint;
  // Host-owned case resolver. It must reject identifiers outside the current case;
  // no model/tool data can install bindings or select endpoints.
  readonly resolveIdentifier: (context: CallContext, identifier: string) => string;
  readonly releaseCase?: (caseRef: string) => void;
}
const CASE_CONNECTIONS = 2;
const reasonOf = (error: unknown): SafeReason => error instanceof McpFailure ? error.reason : "unavailable";
const exact = (value: object, keys: readonly string[]) => { if (Object.keys(value).some((key) => !keys.includes(key))) throw new McpFailure("invalid_request"); };

export function mcpEvidencePorts(ports: Ports, supplied: McpEvidenceOptions): Pick<Ports, "logs" | "code" | "sanitization"> {
  const options = { ...supplied, logs: structuredClone(supplied.logs), code: structuredClone(supplied.code) };
  const sanitization = ports.sanitization;
  const cases = new Map<string, { bytes: number; records: number; windows: Set<string>; coverage: number; phaseId: number; identifiers: Map<string, string> }>();
  const flights = new Set<string>();
  const operations = new Map<string, Set<{ controller: AbortController; transport: BoundedStdio; settled: Promise<void> }>>();
  const clear = (caseRef: string) => {
    cases.get(caseRef)?.identifiers.clear();
    cases.delete(caseRef);
    for (const operation of operations.get(caseRef) ?? []) { operation.controller.abort(); operation.transport.fail("cancelled"); }
    options.releaseCase?.(caseRef);
  };
  ports.retention?.onClose(async () => {
    for (const key of new Set([...cases.keys(), ...operations.keys()])) clear(key);
    // Keep owned operations tracked until their actual child close is confirmed.
    // Retention supplies the existing shared cleanup deadline.
    await Promise.all([...operations.values()].flatMap((owned) => [...owned].map(async (operation) => {
      await operation.transport.close(); await operation.settled;
    })));
  });
  const current = (context: CallContext) => {
    if (context.signal.aborted || ports.retention?.closed()) throw new McpFailure("cancelled");
    if (ports.clock.now() >= context.deadline) throw new McpFailure("timeout");
    if ((cases.get(context.caseRef)?.phaseId ?? context.phaseId) > context.phaseId) throw new McpFailure("cancelled");
  };
  const authorize = async (context: CallContext, action: string) => {
    current(context);
    if (!context.caseRef || !Number.isSafeInteger(context.phaseId) || context.phaseId < 1 || !context.callId ||
      !context.policyVersion || !context.approvalRef || context.resourceRefs.length !== 1 || context.resourceRefs[0] !== "simulator-source" ||
      !context.snapshotRef || !await ports.authorization.allows(action, context)) throw new McpFailure("denied");
    current(context);
  };
  const safe = <T>(context: CallContext, value: T): T => {
    let result: T;
    try { result = ports.sanitization.sanitize(value, context.caseRef); } catch { throw new McpFailure("unsafe_content"); }
    if (!ports.sanitization.safe(result) || /bearer\s|api[_-]?key\s*[:=]|password\s*[:=]|token\s*[:=]/i.test(JSON.stringify(result))) throw new McpFailure("unsafe_content");
    const bounded = (item: unknown): boolean => typeof item === "string" ? Buffer.byteLength(item) <= FRAGMENT_BYTES
      : item !== null && typeof item === "object" ? Object.values(item).every(bounded) : true;
    if (!bounded(result)) throw new McpFailure("unsafe_content");
    return result;
  };
  const call = async (context: CallContext, kind: "logs" | "code", query: LogQuery | { readonly repositoryRef: string; readonly snapshotRef: string }): Promise<Payload> => {
    // Capture host authority before the first await; caller mutation cannot rebind an in-flight invocation.
    const controller = new AbortController();
    context = Object.freeze({ ...context, signal: AbortSignal.any([context.signal, controller.signal]), resourceRefs: Object.freeze([...context.resourceRefs]) });
    query = structuredClone(query);
    const endpoint = options[kind];
    const flightKey = `${context.caseRef}:${kind}`;
    const action = `mcp.${kind === "logs" ? "logs.read" : "code.search"}`;
    const transport = new BoundedStdio(endpoint);
    const owned = operations.get(context.caseRef) ?? new Set();
    if (owned.size >= CASE_CONNECTIONS || [...operations.values()].reduce((sum, item) => sum + item.size, 0) >= MAX_ACTIVE_CASES * CASE_CONNECTIONS) throw new McpFailure("unavailable");
    const settled = Promise.withResolvers<void>();
    const operation = { controller, transport, settled: settled.promise };
    owned.add(operation); operations.set(context.caseRef, owned);
    const client = new Client({ name: "bau-independent-evidence-client", version: "1.0.0" }, { capabilities: {},
      // listTools eagerly caches output validators. This reviewed manifest has no
      // outputSchema: refuse drift before any untrusted schema can be compiled.
      jsonSchemaValidator: { getValidator: () => { throw new McpFailure("schema_mismatch"); } } });
    client.onerror = () => {}; // Raw SDK exceptions never reach a log/telemetry sink.
    const toolName = kind === "logs" ? "read_logs" : "search_code";
    const details: AuditDetails = { tool: { name: toolName, schemaVersion: endpoint.manifest.schemaVersion,
      artifactVersion: endpoint.manifest.artifactVersion, manifestSha256: digest(endpoint.manifest), sanitizationVersion: SANITIZATION_VERSION },
      scope: kind === "logs" ? { sourceRef: "simulator-source", from: (query as LogQuery).from, to: (query as LogQuery).to, pageSize: 100 }
        : { repositoryRef: "simulator-source", snapshotRef: context.snapshotRef } };
    let success = false;
    let leased = false;
    let work: Promise<Payload> | undefined;
    const abort = () => transport.fail("cancelled");
    const perform = async () => {
      await authorize(context, action);
      if (flights.has(flightKey)) throw new McpFailure("unavailable");
      flights.add(flightKey);
      leased = true;
      exact(endpoint, ["command", "args", "artifact", "manifest"]);
      if (canonical(endpoint.manifest) !== canonical(syntheticManifest)) throw new McpFailure("contract_unverified");
      let args: Record<string, unknown>;
      if (kind === "logs") {
        const request = query as LogQuery;
        exact(request, ["sourceRef", "applicationId", "customerId", "from", "to", "pageSize"]);
        if (request.sourceRef !== "simulator-source" || request.pageSize !== 100 || !!request.applicationId === !!request.customerId ||
          !Number.isFinite(Date.parse(request.from)) || !Number.isFinite(Date.parse(request.to)) ||
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
        cases.set(context.caseRef, { bytes: 0, records: 0, windows: new Set(), coverage: 0, phaseId: context.phaseId, identifiers: new Map() });
      }
      const tally = cases.get(context.caseRef)!;
      tally.phaseId = context.phaseId;
      if (kind === "logs") {
        const from = String(args.from), to = String(args.to), key = `${from}/${to}`;
        const coverage = tally.windows.has(key) ? 0 : Date.parse(to) - Date.parse(from);
        if (tally.records >= MAX_LOG_RECORDS || tally.coverage + coverage > 604_800_000) throw new McpFailure("budget_exhausted");
        tally.windows.add(key); tally.coverage += coverage;
      }
      try { await ports.audit.intent(context, action, details); } catch { throw new McpFailure("audit_unavailable"); }
      await authorize(context, action);
      if (!isAbsolute(endpoint.command) || !isAbsolute(endpoint.artifact.path) || !/^[a-f0-9]{64}$/.test(endpoint.artifact.sha256) ||
        createHash("sha256").update(await readFile(endpoint.artifact.path)).digest("hex") !== endpoint.artifact.sha256) throw new McpFailure("contract_unverified");
      await authorize(context, action);
      const remaining = () => Math.max(1, context.deadline - ports.clock.now());
      const requestOptions = () => ({ signal: context.signal, timeout: remaining(), maxTotalTimeout: remaining(), resetTimeoutOnProgress: false });
      await client.connect(transport, requestOptions());
      transport.assertComplete();
      if (canonical(client.getServerVersion()) !== canonical(endpoint.manifest.server) || transport.protocolVersion !== endpoint.manifest.protocolVersion) throw new McpFailure("version_mismatch");
      if (canonical(client.getServerCapabilities()) !== canonical({ tools: {} }) || client.getInstructions() !== undefined) throw new McpFailure("contract_unverified");
      await authorize(context, action);
      const listed = await client.listTools({}, requestOptions());
      transport.assertComplete();
      if (listed.nextCursor || canonical(listed.tools) !== canonical(endpoint.manifest.tools)) throw new McpFailure("schema_mismatch");
      const pages: Payload[] = [];
      const bindings = new Map<string, string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        await authorize(context, action);
        const result = await client.callTool({ name: toolName, arguments: { ...args, ...(cursor ? { cursor } : {}) } }, undefined,
          { ...requestOptions(), onprogress: (progress) => {
            try {
              current(context);
              const cleaned = safe(context, progress);
              if (Buffer.byteLength(JSON.stringify(cleaned)) > FRAGMENT_BYTES) transport.fail("unsafe_content");
            } catch (error) { transport.fail(reasonOf(error)); }
          } });
        current(context);
        transport.assertComplete();
        if (transport.failure) throw new Error(transport.failure);
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
              const alias = safe(context, candidate.applicationId);
              if (Buffer.byteLength(candidate.applicationId) > 1024 || Buffer.byteLength(alias) > 128 || alias === candidate.applicationId ||
                bindings.has(alias) && bindings.get(alias) !== candidate.applicationId) throw new McpFailure("unsafe_content");
              bindings.set(alias, candidate.applicationId);
            }
          } else if (source.value && source.value.applicationRef !== args.applicationId) throw new McpFailure("denied");
        }
        const page = safe(context, source);
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
        const bytes = Buffer.byteLength(JSON.stringify({ ...page, evidence: page.evidence.map((item) =>
          ({ ...item, text: `[untrusted MCP evidence] ${item.text}` })) }));
        if (tally.bytes + bytes > CASE_EVIDENCE_BYTES) throw new McpFailure("unsafe_content");
        tally.bytes += bytes;
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
      try { await ports.audit.complete(context, action, "ok", { ...details, result: { completeness: result.completeness, truncated: result.truncated, evidenceCount: evidence.length } }); }
      catch { throw new McpFailure("audit_unavailable"); }
      await authorize(context, action);
      transport.assertComplete();
      const combined = new Map([...tally.identifiers, ...bindings]);
      if (combined.size > 100 || [...combined].reduce((sum, [alias, raw]) => sum + Buffer.byteLength(alias) + Buffer.byteLength(raw), 0) > MAX_INBOUND_BYTES ||
        [...bindings].some(([alias, raw]) => tally.identifiers.has(alias) && tally.identifiers.get(alias) !== raw)) throw new McpFailure("unsafe_content");
      for (const [alias, raw] of bindings) tally.identifiers.set(alias, raw);
      success = true;
      return result;
    };
    context.signal.addEventListener("abort", abort, { once: true });
    try { return await beforeDeadline(ports.clock, context.deadline, () => { work = perform(); return work; }, context.signal, () => transport.fail("timeout")); }
    catch (error) {
      const reason = transport.failure ?? (context.signal.aborted ? "cancelled" : ports.clock.now() >= context.deadline ? "timeout" : reasonOf(error));
      if (!success && reason !== "audit_unavailable") {
        try { await ports.audit.complete(context, action, reason, details); } catch { throw new McpFailure("audit_unavailable"); }
      }
      throw new McpFailure(reason);
    } finally {
      context.signal.removeEventListener("abort", abort);
      await transport.close();
      await client.close();
      const finish = () => {
        owned.delete(operation);
        if (!owned.size) operations.delete(context.caseRef);
        if (leased) flights.delete(flightKey);
        settled.resolve();
      };
      // A timed-out host wait does not prove an authorization/audit continuation ended.
      // Keep that work visible to retention until its original promise settles.
      if (work) void work.then(finish, finish); else finish();
      // Reaping is asynchronous too: cancellation/phase expiry in that window
      // must not release a previously prepared value after the host has stopped.
      if (success) current(context);
    }
  };
  return {
    logs: { read: (context, query) => call(context, "logs", query) },
    code: { search: async (context, query): Promise<ReadResult<null>> => { const result = await call(context, "code", query); return { ...result, value: null }; } },
    sanitization: { sanitize: (value, caseRef) => sanitization.sanitize(value, caseRef), safe: (value) => sanitization.safe(value),
      clear(caseRef) { clear(caseRef); sanitization.clear(caseRef); } },
  };
}
