import test from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { codebaseMemoryPorts } from "../../src/adapters/codebase-memory/evidence.js";
import { SnapshotCollection } from "../../src/adapters/codebase-memory/collection.js";
import { McpBoundary } from "../../src/adapters/mcp/boundary.js";
import { Troubleshooting } from "../../src/troubleshooting/application/troubleshooting.js";
import type { CallContext } from "../../src/troubleshooting/application/ports.js";
import { ManualClock } from "../fixtures/clock.js";

test("the confirmed B snippet and trace operations return version-bound code evidence through the case", { timeout: 2000 }, async () => {
  const mock = createMockTroubleshooting({ agent: async (_context, request) => {
    await request.invoke("logs.read", null);
    await request.invoke("code.snippet", { repositoryRef: "simulator-source", symbol: "simulator.runSimulator", file: "simulator.ts" });
    await request.invoke("code.trace", { repositoryRef: "simulator-source", symbol: "simulator.runSimulator", file: "simulator.ts", direction: "outbound" });
    return request.generate(request.diagnose());
  } });
  await mock.receive();
  await mock.closed;
  const report = (await mock.delivery.next()).report;
  assert.equal(report.evidence.filter((item) => item.kind === "code").length, 2);
  assert.ok(report.evidence.filter((item) => item.kind === "code").every((item) => item.code?.snapshotRef === "simulator-snapshot-1"));
  assert.equal(mock.events.filter((event) => event.action === "code.snippet").length, 1);
  assert.equal(mock.events.filter((event) => event.action === "code.trace").length, 1);
});

test("B rejects model-supplied native options, unsafe locations and extra case resources before any source process", async () => {
  const mock = createMockTroubleshooting();
  let starts = 0;
  const approved = ["simulator-source"];
  const boundary = new McpBoundary(mock.ports);
  const native = codebaseMemoryPorts(mock.ports, boundary, { approvedCaseResourceRefs: approved,
    collection: new SnapshotCollection("/disabled-synthetic-collection"), resolveTarget: () => "synthetic-target",
    service: () => { starts++; throw new Error("source_must_not_start"); } });
  approved.push("estimate-source");
  const context: CallContext = { caseRef: "case-1", phaseId: 1, callId: "invalid", principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1",
    policyVersion: "synthetic-policy", approvalRef: "synthetic-approval", resourceRefs: ["simulator-source"], snapshotRef: "snapshot-1", budgetRef: "case-1", deadline: 30000, signal: new AbortController().signal };
  const base = { repositoryRef: "simulator-source", snapshotRef: "snapshot-1" };
  for (const query of [{ ...base, pattern: "*", project: "secret" }, { ...base, term: "hello; SELECT" }, { ...base, term: "a".repeat(129) }]) {
    await assert.rejects(native.code.search(context, query as never), /^Error: invalid_request$/);
  }
  for (const file of ["../private.ts", "/private.ts", "folder/../../private.ts", "file:///private.ts", "src\\private.ts"]) {
    await assert.rejects(native.code.snippet(context, { ...base, symbol: "simulator.runSimulator", file }), /^Error: invalid_request$/);
  }
  await assert.rejects(native.code.trace({ ...context, resourceRefs: ["simulator-source", "estimate-source"] },
    { ...base, symbol: "simulator.runSimulator", file: "simulator.ts", direction: "outbound", targetRepositoryRef: "estimate-source" }), /^Error: denied$/);
  assert.equal(starts, 0);
  assert.ok(mock.events.some((event) => event.action === "audit:authorization.denied:complete"));
});

test("A rejects an invalid host repository scope before accepting a case or issuing evidence calls", async () => {
  const mock = createMockTroubleshooting();
  for (const resourceRefs of [[], ["estimate-source"], ["simulator-source", "simulator-source"], ["simulator-source", "a", "b", "c"], ["simulator-source", "../private"]]) {
    const application = new Troubleshooting(mock.ports, { mode: "mock", snapshotRef: "snapshot-1", resourceRefs,
      queryWindow: { from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z" } });
    assert.deepEqual(await application.accept(mock.inbound), { status: "service_unavailable", reason: "invalid_request" });
  }
  assert.equal(mock.events.some((event) => ["admission.confirm", "logs.read", "code.search"].includes(event.action)), false);
});

test("C retains a native B preflight authorization until the original wait settles, even before snapshot IO or process startup", async () => {
  const clock = new ManualClock();
  const actor = { principalRef: "lifecycle-owner", tenantRef: "tenant-1", destinationRef: "lifecycle-path" };
  const mock = createMockTroubleshooting({ clock, lifecycleActors: [actor] });
  const waiting = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const allows = mock.ports.authorization.allows;
  mock.ports.authorization.allows = async (action, context) => {
    if (action === "mcp.code.search") { waiting.resolve(); await release.promise; }
    return allows(action, context);
  };
  let starts = 0, closes = 0;
  const boundary = new McpBoundary(mock.ports);
  const native = codebaseMemoryPorts(mock.ports, boundary, { collection: new SnapshotCollection("/disabled-synthetic-collection"),
    resolveTarget: () => "synthetic-target", service: () => ({ endpoint: { command: process.execPath, args: [],
      artifact: { path: "/disabled-synthetic-artifact", sha256: "0".repeat(64) }, close: async () => { closes++; } },
    start: async () => { starts++; throw new Error("source_must_not_start"); } }) });
  const context: CallContext = { caseRef: "case-1", phaseId: 1, callId: "preflight", principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1",
    policyVersion: "synthetic-policy", approvalRef: "synthetic-approval", resourceRefs: ["simulator-source"], snapshotRef: "snapshot-1", budgetRef: "case-1", deadline: 30000, signal: new AbortController().signal };
  const pending = native.code.search(context, { repositoryRef: "simulator-source", snapshotRef: "snapshot-1" }).catch((error: unknown) => error);
  await waiting.promise;
  await mock.ports.retention!.recordTrigger(actor, { triggerRef: "terminated", kind: "terminated", scope: "poc", decidedAt: clock.utc() });
  clock.advance(30 * 86_400_000);
  const purging = mock.ports.retention!.purgeDue(actor);
  await new Promise(setImmediate); clock.advance(5000);
  assert.equal((await purging).state, "partial");
  assert.equal(starts, 0); assert.equal(closes, 1);
  release.resolve(); assert.match(String(await pending), /timeout|cancelled/);
  await new Promise(setImmediate);
  assert.equal((await mock.ports.retention!.purgeDue(actor)).state, "deleted");
});
