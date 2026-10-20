import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { McpBoundary } from "../../src/adapters/mcp/boundary.js";
import { mcpEvidencePorts } from "../../src/adapters/mcp/evidence.js";
import { syntheticManifest } from "../../src/adapters/mcp/manifest.js";
import type { CallContext, LogQuery } from "../../src/troubleshooting/application/ports.js";
import { ManualClock } from "../fixtures/clock.js";

const service = fileURLToPath(new URL("../fixtures/mcp-service.js", import.meta.url));
const endpoint = (mode = "normal") => ({ command: process.execPath, args: [service, mode],
  artifact: { path: service, sha256: createHash("sha256").update(readFileSync(service)).digest("hex") }, manifest: syntheticManifest });
const resolveIdentifier = (_context: CallContext, value: string) => value;
const context = (phaseId = 1): CallContext => ({ caseRef: "case-1", phaseId, callId: `call-${phaseId}`, principalRef: "principal-1", tenantRef: "tenant-1",
  destinationRef: "private-conversation-1", resourceRefs: ["simulator-source"], snapshotRef: "simulator-snapshot-1", policyVersion: "mock-policy-1",
  approvalRef: "synthetic-approval-1", budgetRef: "case-1", deadline: 30_000, signal: new AbortController().signal });
const query: LogQuery = { sourceRef: "simulator-source", applicationId: "SYNTHETIC-SECRET-APPLICATION", from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z", pageSize: 100 };

test("independent evidence adapters share the same case body limit across logs, code and new phases", async () => {
  const mock = createMockTroubleshooting();
  const boundary = new McpBoundary(mock.ports);
  const logs = mcpEvidencePorts(mock.ports, { logs: endpoint("large_page"), code: endpoint(), resolveIdentifier }, boundary);
  const code = mcpEvidencePorts(mock.ports, { logs: endpoint(), code: endpoint("large_page"), resolveIdentifier }, boundary);
  for (let index = 1; index <= 14; index++) await logs.logs.read(context(index), query);
  await assert.rejects(code.code.search(context(15), { repositoryRef: "simulator-source", snapshotRef: "simulator-snapshot-1" }), /^Error: unsafe_content$/);
});

const lifecycleActor = { principalRef: "lifecycle-owner", tenantRef: "tenant-1", destinationRef: "lifecycle-path" };
async function due(mock: ReturnType<typeof createMockTroubleshooting>, clock: ManualClock) {
  await mock.ports.retention!.recordTrigger(lifecycleActor, { triggerRef: "end", kind: "terminated", decidedAt: clock.utc(), scope: "poc" });
  clock.advance(30 * 86_400_000);
}

test("C keeps aborted startup and held owned-resource closure partial until the original resource really ends", async () => {
  const clock = new ManualClock();
  const mock = createMockTroubleshooting({ clock, lifecycleActors: [lifecycleActor] });
  const boundary = new McpBoundary(mock.ports);
  const start = Promise.withResolvers<void>();
  const stop = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  let alive = false;
  let closeCalls = 0;
  // Ownership of the raw start is established before run can await authorization.
  const originalStart = start.promise.then(() => { alive = true; });
  const resource = { ...endpoint(), close: async () => {
    closeCalls++; closing.resolve(); await originalStart; await stop.promise; alive = false;
  } };
  const adapter = mcpEvidencePorts(mock.ports, { logs: resource, code: endpoint(), resolveIdentifier }, boundary);
  const abort = new AbortController();
  const pending = adapter.logs.read({ ...context(), signal: abort.signal }, query).catch((error: unknown) => error);
  abort.abort();
  await closing.promise;
  await due(mock, clock);
  const first = mock.ports.retention!.purgeDue(lifecycleActor);
  await new Promise(setImmediate); clock.advance(5000);
  assert.equal((await first).state, "partial");
  start.resolve(); await new Promise(setImmediate);
  assert.equal(alive, true);
  const second = mock.ports.retention!.purgeDue(lifecycleActor);
  await new Promise(setImmediate); clock.advance(5000);
  assert.equal((await second).state, "partial");
  stop.resolve();
  assert.match(String(await pending), /cancelled|audit_unavailable/);
  await new Promise(setImmediate);
  assert.equal(alive, false);
  assert.equal(closeCalls, 1);
  assert.equal((await mock.ports.retention!.purgeDue(lifecycleActor)).state, "deleted");
});

test("C cannot report complete deletion when owned-resource cleanup rejected after the stdio child ended", async () => {
  const clock = new ManualClock();
  const mock = createMockTroubleshooting({ clock, lifecycleActors: [lifecycleActor] });
  const boundary = new McpBoundary(mock.ports);
  let closeCalls = 0;
  const resource = { ...endpoint(), close: async () => { closeCalls++; throw new Error("unconfirmed synthetic resource"); } };
  const adapter = mcpEvidencePorts(mock.ports, { logs: resource, code: endpoint(), resolveIdentifier }, boundary);
  await assert.rejects(adapter.logs.read(context(), query), /^Error: unavailable$/);
  await due(mock, clock);
  assert.equal((await mock.ports.retention!.purgeDue(lifecycleActor)).state, "partial");
  assert.equal(closeCalls, 1);
});

test("case cleanup attempts every adapter and original sanitizer and retains failed map ownership for C retry", async () => {
  const clock = new ManualClock();
  const mock = createMockTroubleshooting({ clock, lifecycleActors: [lifecycleActor] });
  let failed = true;
  let otherClears = 0;
  let originalClears = 0;
  mock.ports.sanitization.clear = () => { originalClears++; if (failed) throw new Error("synthetic sanitizer cleanup"); };
  const boundary = new McpBoundary(mock.ports);
  const first = mcpEvidencePorts(mock.ports, { logs: endpoint(), code: endpoint(), resolveIdentifier,
    releaseCase: () => { if (failed) throw new Error("synthetic source mapping cleanup"); } }, boundary);
  mcpEvidencePorts(mock.ports, { logs: endpoint(), code: endpoint(), resolveIdentifier, releaseCase: () => { otherClears++; } }, boundary);
  await first.logs.read(context(), query);
  assert.throws(() => first.sanitization.clear("case-1"), /^Error: unavailable$/);
  assert.equal(otherClears, 1);
  assert.equal(originalClears, 1);
  await due(mock, clock);
  assert.equal((await mock.ports.retention!.purgeDue(lifecycleActor)).state, "partial");
  failed = false;
  assert.equal((await mock.ports.retention!.purgeDue(lifecycleActor)).state, "deleted");
  assert.equal(otherClears, 1);
  assert.ok(originalClears >= 2);
});

test("host-approved full case resources remain pinned across independent log and code profiles", async () => {
  const mock = createMockTroubleshooting(); const boundary = new McpBoundary(mock.ports);
  const approvedCaseResourceRefs = ["simulator-source", "payments-source"];
  const shared = { logs: endpoint(), code: endpoint(), resolveIdentifier, approvedCaseResourceRefs };
  const adapter = mcpEvidencePorts(mock.ports, shared, boundary);
  const full = { ...context(), resourceRefs: approvedCaseResourceRefs };
  await adapter.logs.read(full, query);
  await adapter.code.search(full, { repositoryRef: "simulator-source", snapshotRef: full.snapshotRef });
  await assert.rejects(adapter.logs.read({ ...full, resourceRefs: [...approvedCaseResourceRefs, "foreign-source"] }, query), /denied/);
  await assert.rejects(adapter.logs.read({ ...full, snapshotRef: "changed-snapshot" }, query), /denied/);
});
