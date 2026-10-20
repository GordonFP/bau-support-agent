import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { syntheticPspManifest, EVIDENCE_SCHEMA } from "../../src/adapters/mcp/manifest.js";
import { pspFixture, pspScenario } from "./psp.js";

const mode = (process.argv[2] ?? "psp:unsupported").slice(4);
const server = new Server(syntheticPspManifest.server, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: structuredClone(syntheticPspManifest.tools) }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments!;
  const code = request.params.name === "search_code";
  if (!code && (args.sourceRef !== "psp-log-source" || args.applicationId !== undefined && args.applicationId !== pspFixture.applicationRef ||
    args.customerId !== undefined && args.customerId !== pspFixture.customerRef ||
    args.shopId !== pspFixture.target.shopRef && !(mode === "targets" && args.shopId === undefined) ||
    args.bindingId !== pspFixture.target.bindingRef && !(mode === "targets" && args.bindingId === undefined))) throw new Error("denied");
  if (code && (args.repositoryRef !== "psp-code" || args.snapshotRef !== "simulator-snapshot-1")) throw new Error("denied");
  const value = pspScenario(mode === "targets" ? "unsupported" : mode);
  const points = [{ eventRef: value.target.recordRef, observedAt: value.target.boundAt, value: value.target }, value.first, value.support,
    value.second.transaction, value.second.tailThree, value.final, ...value.linkedShops, ...(value.executions ?? [])];
  const evidence = code ? [{ sourceRef: "psp-code", kind: "code", locator: "psp.ts:10", observedAt: null,
    code: { repositoryRef: "psp-code", branch: "main", commit: "1".repeat(40), snapshotRef: "simulator-snapshot-1",
      indexedAt: "2026-10-19T08:00:00.000Z", receiptRef: "synthetic-psp-snapshot-1",
      ...(value.executions?.[0] ? { pspRule: { ruleRef: value.executions[0].ruleRef, stage: value.executions[0].stage, outcome: value.executions[0].outcome, prerequisite: "one_passed_shop" } }
        : mode === "conflict" ? { pspRule: { ruleRef: "synthetic-policy-conflict", stage: "first", outcome: "waiting", prerequisite: "all_shops_passed" } } : {}) }, text: "Synthetic PSP frozen code; static code alone is not this execution." }]
    : points.filter((point) => point.eventRef && point.observedAt).map((point) => ({ sourceRef: "psp-log-source", kind: "log", locator: point.eventRef,
      observedAt: point.observedAt, log: { from: args.from, to: args.to, queryRef: "synthetic-psp-query-1" }, text: `Synthetic PSP point: ${JSON.stringify(point)}` }));
  return { content: [], structuredContent: { schemaVersion: EVIDENCE_SCHEMA, value: code ? null : mode === "targets" && !args.bindingId ? { kind: "psp_target_candidates", candidates: [
      { applicationId: value.applicationRef, customerId: value.customerRef, shopId: value.target.shopRef, bindingId: "SYNTHETIC-SECRET-BINDING-OLD", boundAt: "2026-10-17T10:00:00.000Z" },
      { applicationId: value.applicationRef, customerId: value.customerRef, shopId: value.target.shopRef, bindingId: value.target.bindingRef, boundAt: value.target.boundAt },
    ] } : value,
    evidence: evidence.map((item) => ({ ...item, acquiredAt: "2026-10-19T09:00:01.000Z", completeness: mode === "other_passed" ? "unknown" : "complete", truncated: false, targetRef: !code && args.customerId ? args.customerId : value.applicationRef })),
    completeness: mode === "other_passed" ? "unknown" : "complete", truncated: false, warnings: ["Owned synthetic PSP fields only; production mapping is unverified."] } };
});
await server.connect(new StdioServerTransport());
