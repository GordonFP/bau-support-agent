import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { syntheticGitLab } from "../fixtures/gitlab.js";
import { kibanaProfile, kibanaServer, logRow, esBody } from "../fixtures/kibana.js";
import { responsesServer } from "../fixtures/responses.js";
import { simulatorResponse } from "../fixtures/pi-runtime.js";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { Troubleshooting } from "../../src/troubleshooting/application/troubleshooting.js";
import { McpBoundary } from "../../src/adapters/mcp/boundary.js";
import { SnapshotCollection, type CollectionReceipt } from "../../src/adapters/codebase-memory/collection.js";
import { codebaseMemoryPorts } from "../../src/adapters/codebase-memory/evidence.js";
import { loadKibanaProfile, kibanaLogPorts } from "../../src/adapters/kibana/logs.js";
import { localReadService, researchImage } from "../../management/codebase-docker.js";
import { createPiRuntime } from "../../src/adapters/pi/runtime.js";
import { createResponsesGateway, responsesModelPolicy } from "../../src/adapters/model/responses.js";
import type { CallContext } from "../../src/troubleshooting/application/ports.js";

const execute = promisify(execFile);
const controller = { docker: "/usr/local/bin/docker", binary: "/tmp/bau-cbm-runtime/bin/codebase-memory-mcp", image: researchImage } as const;
const approved = ["simulator-source", "estimate-source"];
async function removeOwned(root: string): Promise<void> {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) await removeOwned(join(root, entry.name));
  await rm(root, { recursive: true, force: true });
}
async function nativeCollection(source?: string) {
  const gitlab = await syntheticGitLab();
  const root = await mkdtemp(join(tmpdir(), "bau-native-mixed-"));
  try {
    if (source) await gitlab.replaceSource(1, source);
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ mode: "local_synthetic", root, ...controller, gitlab: gitlab.url, repositories: gitlab.repositories.slice(0, 2) }));
    const result = await execute(process.execPath, [fileURLToPath(new URL("../../management/codebase-snapshot.js", import.meta.url)), config], { timeout: 45000, maxBuffer: 16384 });
    const receipt = JSON.parse(result.stdout) as CollectionReceipt;
    const collection = new SnapshotCollection(root);
    return { collection, receipt, close: async () => { await gitlab.close(); await removeOwned(root); } };
  } catch (error) { await gitlab.close(); await removeOwned(root); throw error; }
}
function controlledMock() {
  const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol",
    clock: { now: () => performance.now(), utc: () => new Date().toISOString() } });
  mock.ports.authorization.allows = async (_action, context) => context.principalRef === "principal-1" && context.tenantRef === "tenant-1" &&
    context.destinationRef === "private-conversation-1" && context.resourceRefs.every((resource) => approved.includes(resource));
  return mock;
}

test("one stable full case context and shared boundary join actual Pi, native Kibana and native multi-repository code into an honest retained Simulator report", { timeout: 60000 }, async () => {
  assert.ok(process.env.BAU_KIBANA_TEST_ARTIFACT_CONFIG, "Explicit reviewed external candidate config is required for this native contract.");
  const source = await nativeCollection();
  const backend = await kibanaServer();
  const artifact = await kibanaProfile(backend.url);
  const model = await responsesServer(simulatorResponse);
  const mock = controlledMock();
  const pi = await createPiRuntime({ skillPath: resolve("runtime-skills/bau-troubleshooting/SKILL.md"), clock: mock.ports.clock });
  try {
    const profile = await loadKibanaProfile(artifact);
    assert.equal(profile.value.profile, "local-candidate-1");
    const boundary = new McpBoundary(mock.ports);
    Object.assign(mock.ports, kibanaLogPorts(mock.ports, { profile, approvedCaseResourceRefs: approved, resolveIdentifier: (_context, id) => id }, boundary),
      codebaseMemoryPorts(mock.ports, boundary, { approvedCaseResourceRefs: approved, collection: source.collection,
        service: localReadService(controller, (snapshot) => source.collection.path(snapshot)), resolveTarget: () => "SYNTHETIC-SECRET-APPLICATION" }));
    const closed = mock.ports.agent.close;
    mock.ports.agent.run = pi.run; mock.ports.agent.abort = pi.abort;
    mock.ports.agent.close = async (caseRef, phaseId) => { await pi.close(caseRef, phaseId); await closed(caseRef, phaseId); };
    mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", baseUrl: model.baseUrl, contract: responsesModelPolicy.protocol, clock: mock.ports.clock }).generate;
    const configuredScope = [...approved];
    const application = new Troubleshooting(mock.ports, { mode: "mock", resourceRefs: configuredScope, snapshotRef: source.receipt.snapshotRef,
      modelProfile: "local_protocol", modelPolicy: responsesModelPolicy,
      queryWindow: { from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z" } });
    configuredScope.push("unapproved-source"); // Mutation of the constructor's caller cannot change admitted scope.
    assert.equal((await application.accept(mock.inbound)).status, "accepted"); await mock.closed;
    const view = await application.get(mock.inbound, "case-1");
    assert.ok("state" in view && view.state === "completed", JSON.stringify(view));
    const sent = await mock.delivery.next();
    assert.ok(sent.report.scene === "simulator");
    assert.deepEqual(sent.report.simulator.dataReadiness, { satisfied: 0, missing: 0, unknown: 1 });
    assert.notEqual(sent.report.diagnosticStatus, "located");
    assert.equal(sent.report.evidence.filter((item) => item.kind === "code").length, 1);
    assert.equal(sent.report.evidence.find((item) => item.kind === "code")!.code!.snapshotRef, source.receipt.snapshotRef);
    assert.equal(sent.report.evidence.find((item) => item.kind === "log")!.completeness, "unknown");
    assert.equal(backend.requests.length, 1); assert.equal(model.requests.length, 3);
    const retained = await mock.ports.records.export(mock.inbound, "case-1"); assert.ok(retained?.scope === "full");
    for (const action of ["mcp.logs.read", "mcp.code.search"]) {
      const audit: Readonly<Record<string, unknown>> | undefined = retained.audits.find((entry) => entry.action === action && entry.stage === "complete");
      assert.ok(audit); assert.deepEqual(audit.resourceRefs, approved); assert.equal(audit.snapshotRef, source.receipt.snapshotRef);
    }
    assert.doesNotMatch(JSON.stringify({ sent, retained, model: model.requests }), /SYNTHETIC-SECRET|127\.0\.0\.1|unapproved-source|\/repos\/|\/state\/|controlled\.json|node_modules|\/Users\//);
  } finally { await pi.abort("case-1", 1); await pi.close("case-1", 1); await model.close(); await artifact.close(); await backend.close(); await source.close(); }
});

test("actual native code and log profiles share the 256 KiB case body budget across unchanged full scopes and phases", { timeout: 90000 }, async () => {
  assert.ok(process.env.BAU_KIBANA_TEST_ARTIFACT_CONFIG);
  const source = await nativeCollection(`export function runSimulator(): number {\n${Array.from({ length: 16 }, () => `// synthetic notes ${"x".repeat(180)}`).join("\n")}\nreturn 7;\n}\n`);
  const backend = await kibanaServer((_body, response) => {
    const rows = Array.from({ length: 24 }, (_, rowIndex) => {
      const row = logRow(rowIndex + 1);
      row._source.submitted_shops = Array.from({ length: 20 }, (_, shopIndex) => ({ ...row._source.submitted_shops[0]!, shop_id: `synthetic-shop-${shopIndex}-${"x".repeat(95)}` }));
      return row;
    });
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rawResponse: esBody(rows) }));
  });
  const artifact = await kibanaProfile(backend.url);
  const context = (mock: ReturnType<typeof controlledMock>, caseRef: string, phaseId: number): CallContext => ({ caseRef, phaseId, callId: `${caseRef}:${phaseId}`,
    principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1", policyVersion: "synthetic-policy", approvalRef: "synthetic-approval",
    resourceRefs: approved, snapshotRef: source.receipt.snapshotRef, budgetRef: caseRef, deadline: mock.ports.clock.now() + 30000, signal: new AbortController().signal });
  const query = { sourceRef: "simulator-source" as const, applicationId: "SYNTHETIC-SECRET-APPLICATION", from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z", pageSize: 100 as const };
  try {
    const profile = await loadKibanaProfile(artifact); assert.equal(profile.value.profile, "local-candidate-1");
    // This same literal native log result fits a fresh case by itself.
    const baseline = controlledMock();
    const alone = kibanaLogPorts(baseline.ports, { profile, approvedCaseResourceRefs: approved, resolveIdentifier: (_context, id) => id }, new McpBoundary(baseline.ports));
    assert.equal((await alone.logs.read(context(baseline, "baseline", 1), query)).evidence.length, 24);
    const mock = controlledMock();
    const boundary = new McpBoundary(mock.ports);
    const logs = kibanaLogPorts(mock.ports, { profile, approvedCaseResourceRefs: approved, resolveIdentifier: (_context, id) => id }, boundary);
    const code = codebaseMemoryPorts(mock.ports, boundary, { approvedCaseResourceRefs: approved, collection: source.collection,
      service: localReadService(controller, (snapshot) => source.collection.path(snapshot)), resolveTarget: () => "SYNTHETIC-SECRET-APPLICATION" });
    for (let phaseId = 1; phaseId <= 10; phaseId++) {
      const read = await code.code.snippet(context(mock, "mixed", phaseId), { repositoryRef: "simulator-source", snapshotRef: source.receipt.snapshotRef,
        symbol: "simulator.runSimulator", file: "simulator.ts" });
      assert.equal(read.evidence.length, 1);
    }
    await assert.rejects(logs.logs.read(context(mock, "mixed", 11), query), /^Error: unsafe_content$/);
    assert.equal(backend.requests.length, 2);
    assert.doesNotMatch(JSON.stringify(mock.events), /SYNTHETIC-SECRET|127\.0\.0\.1|controlled\.json/);
  } finally { await artifact.close(); await backend.close(); await source.close(); }
});
