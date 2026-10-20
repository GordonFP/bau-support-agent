import type { CallContext, Ports, ReadResult, SafeReason } from "../../troubleshooting/application/ports.js";
import { codeQuery, type CodeOperation, type CodeQuery } from "../../troubleshooting/application/code-query.js";
import { deniedContext, recordDenial } from "../../troubleshooting/application/authorization-audit.js";
import { caseRepositories, caseResources } from "../../troubleshooting/application/resource-scope.js";
import { TOOL_CALL_MS } from "../../troubleshooting/application/limits.js";
import { McpBoundary, type OwnedMcpEndpoint } from "../mcp/boundary.js";
import { McpFailure } from "../mcp/failure.js";
import { canonical, digest, FRAGMENT_BYTES, SANITIZATION_VERSION } from "../mcp/manifest.js";
import { SnapshotCollection, binarySha256, fileSha256, type CollectionReceipt } from "./collection.js";
import { pspRule } from "./psp-rule.js";
import { nativeManifest } from "./native-manifest.js";
import { searchResult, snippetResult, traceResult, type NativeRead } from "./native-result.js";

export interface CodebaseMemoryOptions {
  readonly approvedCaseResourceRefs?: readonly string[];
  readonly collection: SnapshotCollection;
  // Reviewed deployment/controller supplies an isolated identity and ONLY the physical collection scope.
  // No executable/path/endpoint/native option can originate in a query or model response.
  // service only plans the descriptor synchronously; start(receipt) owns every actual creation await.
  readonly service: (snapshotRef: string) => { readonly endpoint: OwnedMcpEndpoint & { readonly close: () => Promise<void> }; start(receipt: CollectionReceipt): Promise<void> };
  readonly resolveTarget: (context: CallContext) => string;
}
const reason = (error: unknown): SafeReason => error instanceof McpFailure ? error.reason : "unavailable";
export function codebaseMemoryPorts(ports: Ports, boundary: McpBoundary, supplied: CodebaseMemoryOptions): Pick<Ports, "code"> {
  const options = { ...supplied };
  let approved: readonly string[];
  try { approved = caseResources(supplied.approvedCaseResourceRefs ?? ["simulator-source"]); } catch { throw new McpFailure("contract_unverified"); }
  const repositories = caseRepositories(approved);
  const call = async (context: CallContext, operation: CodeOperation, value: CodeQuery): Promise<ReadResult<null>> => {
    context = Object.freeze({ ...context, deadline: Math.min(context.deadline, ports.clock.now() + TOOL_CALL_MS), resourceRefs: Object.freeze([...context.resourceRefs]) });
    let query: CodeQuery;
    try { query = codeQuery(operation, value); } catch { throw new McpFailure("invalid_request"); }
    const action = `mcp.code.${operation}`;
    const requested = [query.repositoryRef, ...("targetRepositoryRef" in query && query.targetRepositoryRef ? [query.targetRepositoryRef] : [])];
    if (context.snapshotRef !== query.snapshotRef || canonical([...context.resourceRefs].sort()) !== canonical([...approved].sort()) ||
      requested.some((resource) => !repositories.includes(resource))) throw new McpFailure("denied");
    const authorize = async (bound: CallContext) => {
      if (!bound.caseRef || !Number.isSafeInteger(bound.phaseId) || bound.phaseId < 1 || !bound.callId || !bound.approvalRef || !bound.policyVersion ||
        !bound.snapshotRef || bound.snapshotRef !== query.snapshotRef || canonical([...bound.resourceRefs].sort()) !== canonical([...approved].sort()) ||
        requested.some((resource) => !repositories.includes(resource))) throw new McpFailure("denied");
      for (const resourceRef of repositories) {
        if (!await ports.authorization.allows(action, { ...bound, resourceRefs: [resourceRef] })) throw new McpFailure("denied");
      }
    };
    // A descriptor has a stable owned process name before any asynchronous work.
    // The shared boundary can therefore track authorization, hashing and startup together.
    const service = options.service(context.snapshotRef);
    if (typeof service.endpoint.close !== "function") throw new McpFailure("contract_unverified");
    type Lease = Awaited<ReturnType<SnapshotCollection["lease"]>>;
    let leaseWork: Promise<Lease> | undefined;
    let verificationWork: Promise<void> | undefined;
    let lease: Lease | undefined;
    const endpoint = { ...service.endpoint, close: async () => {
      const stopped = service.endpoint.close();
      const settled = await Promise.allSettled([stopped, leaseWork, verificationWork]);
      if (settled[0]?.status === "rejected") throw new McpFailure("unavailable");
      await lease?.release();
    } };
    return boundary.run(context, "codebase-memory", endpoint, authorize, async (native) => {
        const bound = native.context;
        const tool = operation === "search" ? ((query as import("../../troubleshooting/application/ports.js").CodeSearchQuery).kind === "symbol" ? "search_graph" : "search_code")
          : operation === "snippet" ? "get_code_snippet" : "trace_path";
        const details = { tool: { name: tool, schemaVersion: "codebase-memory-closed-1", artifactVersion: "0.12.1",
          manifestSha256: digest(nativeManifest), sanitizationVersion: SANITIZATION_VERSION },
          scope: { repositoryRef: query.repositoryRef, snapshotRef: bound.snapshotRef } };
        let intent = false;
        try {
          try { await ports.audit.intent(bound, action, details); intent = true; } catch { throw new McpFailure("audit_unavailable"); }
          native.current(); await authorize(bound); native.current();
          leaseWork = options.collection.lease(bound.snapshotRef);
          void leaseWork.then((value) => { lease = value; }, () => {});
          const selected = await leaseWork; native.current();
          // A cross-linked DB is never mounted for a narrower permission scope.
          const scope = selected.receipt.repositories.map((item) => item.repositoryRef);
          if (canonical([...scope].sort()) !== canonical([...repositories].sort())) throw new McpFailure("denied");
          const repository = selected.receipt.repositories.find((item) => item.repositoryRef === query.repositoryRef);
          if (!repository || requested.some((item) => !scope.includes(item)) ||
            ("file" in query && !repository.files.includes(query.file))) throw new McpFailure("denied");
          if (endpoint.artifact.sha256 !== binarySha256 || await fileSha256(endpoint.artifact.path) !== binarySha256) throw new McpFailure("contract_unverified");
          native.current();
          await service.start(structuredClone(selected.receipt)); native.current();
          const connected = await native.connect();
          if (canonical(connected.serverInfo) !== canonical(nativeManifest.server) || connected.protocolVersion !== "2025-11-25" ||
            canonical(connected.capabilities) !== canonical({ prompts: { listChanged: false }, tools: { listChanged: false } })) throw new McpFailure("contract_unverified");
          // Native prompts/instructions are neither requested nor placed in model context.
          const manifest = await native.listTools();
          if (canonical(manifest.tools.map((entry) => ({ name: entry.name, sha256: digest(entry) }))) !== canonical(nativeManifest.tools) || manifest.nextCursor) throw new McpFailure("schema_mismatch");
          let result: NativeRead;
          const output = { project: repository.project, format: "json", max_output_tokens: 1500 };
          if (operation === "search") {
            const search = query as import("../../troubleshooting/application/ports.js").CodeSearchQuery;
            const kind = search.kind ?? "source";
            result = searchResult(await native.callTool(tool, kind === "symbol" ? { ...output, query: search.term ?? "runSimulator", limit: 5 }
              : { ...output, pattern: search.term ?? "runSimulator", regex: false, mode: "full", limit: 5, result_limit: 5, source_max_lines: 20 }), repository, kind);
          } else if (operation === "snippet" && "symbol" in query) {
            result = snippetResult(await native.callTool(tool, { ...output, qualified_name: `${repository.project}.${query.symbol}`,
              source_mode: "full", max_lines: 20 }), repository, query.symbol, query.file);
          } else if (operation === "trace" && "direction" in query) {
            result = traceResult(await native.callTool(tool, { ...output, function_name: `${repository.project}.${query.symbol}`,
              direction: query.direction, depth: 2, limit: 5, include_evidence: true,
              ...(query.targetRepositoryRef ? { mode: "cross_service" } : {}) }), repository, query.symbol, query.direction, selected.receipt.repositories, !!query.targetRepositoryRef);
          } else throw new McpFailure("invalid_request");
          verificationWork = selected.verify(); await verificationWork; native.current(); await authorize(bound); native.current();
          const targetRef = options.resolveTarget(bound);
          if (typeof targetRef !== "string" || !targetRef || Buffer.byteLength(targetRef) > 1024) throw new McpFailure("denied");
          const completeness = result.unknown ? "unknown" as const : result.partial ? "partial" as const : "complete" as const;
          const read = native.sanitize({ value: null, evidence: result.evidence.map((item) => ({
            sourceRef: item.repository.repositoryRef, kind: "code" as const, locator: item.locator, observedAt: null,
            acquiredAt: ports.clock.utc(), completeness, truncated: result.partial, targetRef,
            text: `[untrusted Codebase Memory evidence] ${item.text}`,
            code: { repositoryRef: item.repository.repositoryRef, branch: item.repository.branch, commit: item.repository.commit,
              ...(pspRule(item.text) ? { pspRule: pspRule(item.text)! } : {}), snapshotRef: bound.snapshotRef, indexedAt: item.repository.indexedAt, receiptRef: `sha256:${selected.receipt.receiptSha256}` },
          })), completeness, truncated: result.partial,
          warnings: ["Static code relationships do not prove this execution or a historical production deployment.",
            "Index coverage is best effort; zero hits do not prove absence.", ...(result.partial ? ["Native result is partial or truncated."] : []),
            ...(result.unknown ? ["The fixed native cross-service response omits destination metadata; no cross-repository destination is proven."] : [])] });
          if (read.evidence.some((item) => Buffer.byteLength(item.text) > FRAGMENT_BYTES)) throw new McpFailure("unsafe_content");
          boundary.chargeEvidence(bound, read);
          native.current(); await authorize(bound); native.current();
          try { await ports.audit.complete(bound, action, "ok", { ...details, result: { completeness, truncated: result.partial, evidenceCount: read.evidence.length } }); }
          catch { throw new McpFailure("audit_unavailable"); }
          native.current();
          return read;
        } catch (error) {
          if (intent && reason(error) !== "audit_unavailable") {
            try { await ports.audit.complete(bound, action, "failed", details); } catch { throw new McpFailure("audit_unavailable"); }
          }
          throw error instanceof McpFailure ? error : new McpFailure("unavailable");
        }
      });
  };
  const bounded = async (context: CallContext, operation: CodeOperation, query: CodeQuery) => {
    try { return await call(context, operation, query); }
    catch (error) {
      if (reason(error) === "denied") {
        try { await recordDenial(ports.audit, deniedContext(context, context.caseRef, ports)); } catch { throw new McpFailure("audit_unavailable"); }
      }
      throw new McpFailure(reason(error));
    }
  };
  return { code: { search: (context, query) => bounded(context, "search", query), snippet: (context, query) => bounded(context, "snippet", query), trace: (context, query) => bounded(context, "trace", query) } };
}
