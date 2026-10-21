import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { chmod, symlink } from "node:fs/promises";
import { SqliteRecords } from "../../src/adapters/records/sqlite.js";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import type { CallContext, CaseView } from "../../src/troubleshooting/application/ports.js";
import { ManualClock } from "../fixtures/clock.js";

const actor = { principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1" };
const context: CallContext = { ...actor, caseRef: "case-1", phaseId: 1, callId: "case-1:accept", policyVersion: "mock-policy-1",
  approvalRef: "mock-approval-1", resourceRefs: ["simulator-source"], snapshotRef: "simulator-snapshot-1", budgetRef: "case-1",
  deadline: 180_000, signal: new AbortController().signal };
const view: CaseView = { caseRef: "case-1", phaseId: 1, state: "investigating", receivedAt: "2026-10-19T09:00:00Z",
  acceptedAt: "2026-10-19T09:00:00Z", phaseStartedAt: "2026-10-19T09:00:00Z", deadlineAt: "2026-10-19T09:03:00Z",
  deliveryStatus: "pending", usage: { modelAttempts: 0, logRecords: 0, logCoverageMs: 0 }, elapsedMs: 0,
  phases: [{ phaseId: 1, startedAt: "2026-10-19T09:00:00Z" }], inputWaits: [] };

test("C commits acceptance and sanitized records; restart interrupts unfinished work without losing its event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-records-"));
  const mock = createMockTroubleshooting();
  let store: SqliteRecords | undefined;
  try {
    store = new SqliteRecords(directory, mock.ports);
    const accepted = await store.admission.confirm({ key: "a".repeat(64), caseRef: "case-1", principalRef: actor.principalRef,
      initial: { context, view, input: { applicationId: "[case-1:application]", question: "Why?" } } });
    assert.equal(accepted.status, "confirmed");
    await store.records.append(context, { recordRef: "case-1:model:1:input", schemaVersion: 1, kind: "model_input", payload: { question: "Why?" } });
    store.close();
    store = new SqliteRecords(directory, mock.ports);
    const restored = await store.records.read(actor, "case-1");
    assert.ok(restored?.scope === "full");
    assert.equal(restored.view.state, "stopped");
    assert.equal(restored.view.stopReason, "interrupted");
    assert.ok(restored.records.some((record) => record.kind === "view" && (record.payload as CaseView).stopReason === "interrupted"));
    assert.ok(restored.audits.some((entry) => entry.action === "restart.interrupt" && entry.outcome === "interrupted"));
    assert.ok(restored.records.some((record) => record.kind === "model_input" && (record.payload as { question: string }).question === "Why?"));
    const duplicate = await store.admission.confirm({ key: "a".repeat(64), caseRef: "case-2", principalRef: actor.principalRef,
      initial: { context: { ...context, caseRef: "case-2" }, view: { ...view, caseRef: "case-2" }, input: { question: "Why?" } } });
    assert.equal(duplicate.status, "duplicate");
    assert.ok("view" in duplicate);
    assert.equal(duplicate.view?.stopReason, "interrupted");
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("A survives a completed-case restart: duplicates are not reinvestigated and new events receive fresh references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-restart-"));
  let store: SqliteRecords | undefined;
  const boot = () => createMockTroubleshooting({ controlPorts: (ports) => {
    store = new SqliteRecords(directory, ports);
    return { admission: store.admission, records: store.records, deliveryLedger: store.deliveryLedger, audit: store.audit, budget: store.budget };
  } });
  try {
    const first = boot();
    const accepted = await first.receive();
    assert.ok("view" in accepted);
    await first.closed;
    store!.close();
    const restarted = boot();
    const duplicate = await restarted.receive();
    assert.equal(duplicate.status, "duplicate");
    assert.ok("view" in duplicate);
    assert.equal(duplicate.view.state, "completed");
    assert.equal(duplicate.view.caseRef, accepted.view.caseRef);
    const replay = await restarted.receive();
    assert.deepEqual(replay, duplicate);
    const allows = restarted.ports.authorization.allows;
    restarted.ports.authorization.allows = async (action, authority) => action !== "records.read" && allows(action, authority);
    assert.deepEqual(await restarted.receive(), { status: "denied", reason: "denied" });
    restarted.ports.authorization.allows = allows;
    assert.equal(restarted.events.some((event) => ["logs.read", "model.generate", "delivery.send"].includes(event.action)), false);
    const view = await restarted.application.get(actor, accepted.view.caseRef);
    assert.ok("state" in view);
    assert.equal(view.state, "completed");
    const next = await restarted.receive({ eventRef: "event-next" });
    assert.equal(next.status, "accepted");
    assert.ok("view" in next);
    assert.notEqual(next.view.caseRef, accepted.view.caseRef);
    await restarted.closed;
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a persisted duplicate remains readable after restart when 32 new cases fill active capacity", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-replay-full-"));
  let store: SqliteRecords | undefined;
  const hold = Promise.withResolvers<void>();
  const boot = (waiting = false) => createMockTroubleshooting({ ...(waiting ? { agent: async () => { await hold.promise; return null; } } : {}),
    controlPorts: (ports) => {
      store = new SqliteRecords(directory, ports);
      return { admission: store.admission, records: store.records, deliveryLedger: store.deliveryLedger, audit: store.audit, budget: store.budget };
    } });
  const active: string[] = [];
  let restarted: ReturnType<typeof createMockTroubleshooting> | undefined;
  try {
    const first = boot();
    await first.receive();
    await first.closed;
    store!.close();
    restarted = boot(true);
    for (let index = 0; index < 32; index++) {
      const accepted = await restarted.receive({ eventRef: `new-${index}` });
      assert.equal(accepted.status, "accepted");
      if ("view" in accepted) active.push(accepted.view.caseRef);
    }
    const business = () => restarted!.events.filter((event) => ["agent.run", "logs.read", "model.generate", "delivery.send"].includes(event.action)).length;
    const before = business();
    for (let replay = 0; replay < 2; replay++) {
      const duplicate = await restarted.receive();
      assert.ok(duplicate.status === "duplicate" && duplicate.view.caseRef === "case-1" && duplicate.view.state === "completed");
    }
    assert.equal(business(), before);
    assert.equal((await restarted.receive({ eventRef: "overflow" })).status, "service_unavailable");
  } finally {
    if (restarted) for (const ref of active) await restarted.application.cancel(actor, ref);
    hold.resolve();
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("persisted-event lookup coalesces bounded waits and a late lookup cannot start investigation after its deadline", async () => {
  const clock = new ManualClock();
  const mock = createMockTroubleshooting({ clock });
  const hold = Promise.withResolvers<void>();
  let lookups = 0;
  mock.ports.admission.lookup = async () => { lookups++; await hold.promise; return null; };
  const first = mock.receive();
  const same = mock.receive();
  const pending = Array.from({ length: 31 }, (_, index) => mock.receive({ eventRef: `lookup-${index}` }));
  assert.equal(lookups, 32);
  assert.deepEqual(await mock.receive({ eventRef: "overflow" }), { status: "service_unavailable", reason: "unavailable" });
  clock.advance(180_000);
  const timedOut = { status: "service_unavailable", reason: "timeout" };
  assert.deepEqual(await first, timedOut);
  assert.deepEqual(await same, timedOut);
  for (const result of await Promise.all(pending)) assert.deepEqual(result, timedOut);
  assert.deepEqual(await mock.receive({ eventRef: "still-full" }), { status: "service_unavailable", reason: "unavailable" });
  hold.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mock.events.length, 0);
  assert.equal((await mock.receive({ eventRef: "fresh" })).status, "accepted");
  await mock.closed;
});

test("a new-event lookup and acceptance controls share the original 180-second host deadline", async () => {
  const clock = new ManualClock();
  const mock = createMockTroubleshooting({ clock });
  const lookup = Promise.withResolvers<void>();
  const authorization = Promise.withResolvers<void>();
  const checking = Promise.withResolvers<void>();
  mock.ports.admission.lookup = async () => { await lookup.promise; return null; };
  const allows = mock.ports.authorization.allows;
  mock.ports.authorization.allows = async (action, authority) => {
    if (action === "accept") { checking.resolve(); await authorization.promise; }
    return allows(action, authority);
  };
  let settled = false;
  const acceptance = mock.receive().then((result) => { settled = true; return result; });
  try {
    clock.advance(179_000);
    lookup.resolve();
    await checking.promise;
    clock.advance(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, true);
    assert.deepEqual(await acceptance, { status: "service_unavailable", reason: "timeout" });
  } finally { lookup.resolve(); authorization.resolve(); clock.advance(360_000); }
  await acceptance;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mock.events.length, 0);
});

test("C exports versioned sanitized model exchanges, evidence and report without raw source selectors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-artifacts-"));
  let store: SqliteRecords | undefined;
  try {
    const mock = createMockTroubleshooting({ controlPorts: (ports) => {
      store = new SqliteRecords(directory, ports);
      return { admission: store.admission, records: store.records, deliveryLedger: store.deliveryLedger, audit: store.audit, budget: store.budget };
    } });
    await mock.receive();
    await mock.closed;
    const saved = await store!.records.export(actor, "case-1");
    assert.ok(saved?.scope === "full");
    for (const kind of ["input", "model_input", "model_output", "evidence", "report"]) {
      assert.ok(saved.records.some((record) => record.kind === kind && record.schemaVersion === 1), kind);
    }
    assert.doesNotMatch(JSON.stringify(saved), /SYNTHETIC-SECRET|signal|applicationId":"SYNTHETIC/);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C keeps unknown reservations and known settlements across restart; repeated settlement does not charge twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-ledger-"));
  const mock = createMockTroubleshooting();
  let store: SqliteRecords | undefined;
  try {
    store = new SqliteRecords(directory, mock.ports);
    const firstCall = { ...context, callId: "case-1:phase-1:model:1" };
    const unknownCall = { ...context, callId: "case-1:phase-1:model:2" };
    await store.budget.reserve(firstCall, 180_000);
    await store.budget.reserve(unknownCall, 180_000);
    await store.budget.settle(firstCall, 4_000);
    await store.budget.settle(firstCall, 4_000);
    await store.budget.settle(unknownCall, null);
    assert.equal((await store.budget.status("case-1")).reservedMicrousd, 184_000);
    store.close();
    store = new SqliteRecords(directory, mock.ports);
    assert.equal((await store.budget.status("case-1")).reservedMicrousd, 184_000);
    await store.budget.settle(firstCall, 4_000);
    assert.equal((await store.budget.status("case-1")).reservedMicrousd, 184_000);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("restart interrupts a model in flight and preserves its attempt count and unknown reservation without resuming", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-interrupted-"));
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let store: SqliteRecords | undefined;
  const controlPorts = (ports: ReturnType<typeof createMockTroubleshooting>["ports"]) => {
    store = new SqliteRecords(directory, ports);
    return { admission: store.admission, records: store.records, deliveryLedger: store.deliveryLedger, audit: store.audit, budget: store.budget };
  };
  try {
    const first = createMockTroubleshooting({ controlPorts, model: async (_context, draft) => {
      started.resolve(); await finish.promise; return { candidate: draft, actualMicrousd: null };
    } });
    await first.receive();
    await started.promise;
    store!.close();
    const restarted = createMockTroubleshooting({ controlPorts });
    const duplicate = await restarted.receive();
    assert.ok("view" in duplicate);
    assert.equal(duplicate.view.stopReason, "interrupted");
    assert.equal(duplicate.view.usage.modelAttempts, 1);
    assert.equal((await store!.budget.status("case-1")).reservedMicrousd, 180_000);
    assert.equal(restarted.events.some((event) => ["logs.read", "model.generate", "delivery.send"].includes(event.action)), false);
    finish.resolve();
    await first.closed;
  } finally { finish.resolve(); store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a failed acceptance transaction leaves no partial case or event and the same event can be committed once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-rollback-"));
  const mock = createMockTroubleshooting();
  let broken = true;
  let store: SqliteRecords | undefined;
  try {
    store = new SqliteRecords(directory, mock.ports, { fault: (checkpoint) => {
      if (broken && checkpoint === "admission:before_commit") throw new Error("synthetic-disk-full");
    } });
    const record = { key: "b".repeat(64), caseRef: "case-1", principalRef: actor.principalRef, initial: { context, view, input: { question: "Why?" } } };
    await assert.rejects(store.admission.confirm(record), { message: "unavailable" });
    assert.equal(await store.records.read(actor, "case-1"), null);
    broken = false;
    assert.equal((await store.admission.confirm(record)).status, "confirmed");
    const saved = await store.records.read(actor, "case-1");
    assert.ok(saved?.scope === "full");
    assert.equal(saved.records.filter((item) => item.kind === "input").length, 1);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

const childStore = (directory: string, mode: string) => {
  const child = spawn(process.execPath, [new URL("../fixtures/sqlite-process.js", import.meta.url).pathname, directory, mode],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  return { child, output: () => output };
};

test("the lifetime lock refuses a second process and is reacquired after graceful close and SIGKILL", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-process-lock-"));
  let store: SqliteRecords | undefined;
  let holder: ReturnType<typeof childStore> | undefined;
  try {
    store = new SqliteRecords(directory, createMockTroubleshooting().ports);
    const competing = childStore(directory, "probe");
    await once(competing.child, "close");
    assert.equal(competing.output(), "refused:unavailable\n");
    store.close();
    holder = childStore(directory, "hold");
    await once(holder.child.stdout!, "data");
    assert.equal(holder.output(), "opened\n");
    holder.child.kill("SIGKILL");
    await once(holder.child, "close");
    store = new SqliteRecords(directory, createMockTroubleshooting().ports);
    const again = childStore(directory, "probe");
    await once(again.child, "close");
    assert.equal(again.output(), "refused:unavailable\n");
  } finally { holder?.child.kill("SIGKILL"); store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("process death in the acceptance transaction rolls back both case and event before the next process starts", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-process-crash-"));
  let store: SqliteRecords | undefined;
  try {
    const crashing = childStore(directory, "crash");
    await once(crashing.child, "close");
    assert.equal(crashing.output(), "transaction-written\n");
    store = new SqliteRecords(directory, createMockTroubleshooting().ports);
    assert.equal(await store.records.read(actor, "case-1"), null);
    assert.equal((await store.admission.confirm({ key: "c".repeat(64), caseRef: "case-1", principalRef: actor.principalRef,
      initial: { context, view, input: { question: "Why?" } } })).status, "confirmed");
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C append requires current owner authorization and a stable record reference cannot replace different content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-record-binding-"));
  const denyActions: string[] = [];
  const mock = createMockTroubleshooting({ denyActions });
  let store: SqliteRecords | undefined;
  try {
    store = new SqliteRecords(directory, mock.ports);
    await store.admission.confirm({ key: "d".repeat(64), caseRef: "case-1", principalRef: actor.principalRef, initial: { context, view, input: { question: "Why?" } } });
    const record = { recordRef: "case-1:fixed-view", schemaVersion: 1 as const, kind: "view" as const, payload: { ...view, state: "awaiting_input" as const } };
    await assert.rejects(store.records.append({ ...context, principalRef: "other" }, record), { message: "denied" });
    denyActions.push("records.append");
    await assert.rejects(store.records.append(context, record), { message: "denied" });
    denyActions.pop();
    await store.records.append(context, record);
    await store.records.append(context, record);
    await assert.rejects(store.records.append(context, { ...record, payload: { ...view, state: "stopped", stopReason: "cancelled" } }), { message: "unavailable" });
    const saved = await store.records.read(actor, "case-1");
    assert.ok(saved?.scope === "full");
    assert.equal(saved.view.state, "awaiting_input");
    assert.equal(saved.records.filter((item) => item.recordRef === record.recordRef).length, 1);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C audit carries bounded scope, authorization, completeness and settlement source instead of response bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-audit-fields-"));
  let store: SqliteRecords | undefined;
  try {
    const mock = createMockTroubleshooting({ controlPorts: (ports) => {
      store = new SqliteRecords(directory, ports);
      return { admission: store.admission, records: store.records, deliveryLedger: store.deliveryLedger, audit: store.audit, budget: store.budget };
    } });
    await mock.receive();
    await mock.closed;
    const saved = await store!.records.export(actor, "case-1");
    assert.ok(saved?.scope === "full");
    const log = saved.audits.find((entry) => entry.action === "logs.read" && entry.stage === "complete")!;
    assert.deepEqual(log.authorization, { decision: "allowed", reason: "policy_allowed" });
    assert.deepEqual(log.scope, { sourceRef: "simulator-source", from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z", pageSize: 100 });
    assert.deepEqual(log.result, { completeness: "complete", truncated: false, evidenceCount: 1 });
    assert.equal(log.sanitizationVersion, "mock-sanitization-1");
    assert.equal(log.toolSchemaVersion, "mock-schema-1");
    assert.equal(log.operationId, log.callId);
    const model = saved.audits.find((entry) => entry.action === "model.generate" && entry.stage === "complete")!;
    assert.deepEqual(model.settlement, { source: "mock_usage", state: "settled", reservedMicrousd: 180_000, actualMicrousd: 1_000 });
    assert.doesNotMatch(JSON.stringify(saved.audits), /SYNTHETIC-SECRET|Why is|shop-10|coverageComplete/);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a crash after platform send preserves the original segment as delivery_unknown and restart never replays it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-delivery-unknown-"));
  const sent = Promise.withResolvers<void>();
  const confirm = Promise.withResolvers<void>();
  let store: SqliteRecords | undefined;
  const controlPorts = (ports: ReturnType<typeof createMockTroubleshooting>["ports"]) => {
    store = new SqliteRecords(directory, ports);
    return { admission: store.admission, records: store.records, deliveryLedger: store.deliveryLedger, audit: store.audit, budget: store.budget };
  };
  try {
    const first = createMockTroubleshooting({ controlPorts });
    const send = first.ports.delivery.send;
    first.ports.delivery.send = async (destination, report, key) => {
      const result = await send(destination, report, key); sent.resolve(); await confirm.promise; return result;
    };
    await first.receive();
    await sent.promise;
    store!.close();
    const restarted = createMockTroubleshooting({ controlPorts });
    const duplicate = await restarted.receive();
    assert.ok("view" in duplicate);
    assert.equal(duplicate.view.deliveryStatus, "unknown");
    const saved = await store!.records.read(actor, "case-1");
    assert.ok(saved?.scope === "full");
    const reportDeliveries = saved.deliveries.filter((item) => item.deliveryKey === "case-1:report:1");
    assert.ok(saved.deliveries.some((item) => item.deliveryKey === "case-1:status:1" && item.status === "delivered"));
    assert.equal(reportDeliveries.length, 1);
    assert.equal(reportDeliveries[0]!.deliveryKey, "case-1:report:1");
    assert.equal(reportDeliveries[0]!.segment, 1);
    assert.equal(reportDeliveries[0]!.status, "unknown");
    assert.match(reportDeliveries[0]!.callId, /case-1:phase-1:delivery.send:/);
    assert.equal(restarted.events.some((event) => ["logs.read", "model.generate", "delivery.send"].includes(event.action)), false);
    confirm.resolve();
    await first.closed;
  } finally { confirm.resolve(); store?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const failure of ["audit:logs.read:intent", "audit:logs.read:complete", "audit:delivery.send:complete"] as const) {
  test(`SQLite write fault at ${failure} rolls back the audit and blocks subsequent business output`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "bau-sqlite-fault-"));
    let store: SqliteRecords | undefined;
    try {
      const mock = createMockTroubleshooting({ controlPorts: (ports) => {
        store = new SqliteRecords(directory, ports, { fault: (checkpoint) => {
          if (checkpoint === failure) throw new Error("synthetic-storage-failure");
        } });
        return { admission: store.admission, records: store.records, deliveryLedger: store.deliveryLedger, audit: store.audit, budget: store.budget };
      } });
      await mock.receive();
      await mock.closed;
      await new Promise(setImmediate);
      assert.equal(mock.events.filter((event) => event.action === "logs.read").length, failure.endsWith("intent") ? 0 : 1);
      assert.equal(mock.events.filter((event) => event.action === "model.generate").length, failure.includes("delivery") ? 1 : 0);
      assert.equal(mock.events.filter((event) => event.action === "delivery.send").length, failure.includes("delivery") ? 1 : 0);
      assert.equal(mock.events.filter((event) => event.action === "delivery.fault").length, failure.endsWith("intent") ? 0 : 1);
      const saved = await store!.records.read(actor, "case-1");
      assert.ok(saved?.scope === "full");
      assert.equal(saved.view.stopReason, "audit_unavailable");
      if (failure.includes("delivery")) assert.equal(saved.deliveries[0]!.status, "unknown");
    } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

for (const adapter of ["mock", "sqlite"] as const) {
  test(`${adapter} C read and export each reauthorize the current owner and audit denials`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "bau-record-access-"));
    const denyActions: string[] = [];
    let store: SqliteRecords | undefined;
    try {
      const mock = createMockTroubleshooting({ denyActions, ...(adapter === "sqlite" ? { controlPorts: (ports: ReturnType<typeof createMockTroubleshooting>["ports"]) => {
        store = new SqliteRecords(directory, ports);
        return { admission: store.admission, records: store.records, deliveryLedger: store.deliveryLedger, audit: store.audit, budget: store.budget };
      } } : {}) });
      await mock.receive();
      await mock.closed;
      const records = mock.ports.records;
      assert.equal(await records.read({ ...actor, principalRef: "other" }, "case-1"), null);
      assert.equal(await records.export({ ...actor, destinationRef: "other" }, "case-1"), null);
      denyActions.push("records.export");
      assert.equal(await records.export(actor, "case-1"), null);
      assert.ok(await records.read(actor, "case-1"));
      denyActions.push("records.read");
      assert.equal(await records.read(actor, "case-1"), null);
      denyActions.length = 0;
      const saved = await records.export(actor, "case-1");
      assert.ok(saved?.scope === "full");
      if (adapter === "sqlite") assert.ok(saved.audits.filter((entry) => entry.action === "authorization.denied" && entry.stage === "complete").length >= 4);
      else assert.ok(mock.events.filter((entry) => entry.action === "audit:authorization.denied:complete").length >= 4);
    } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test("a delayed earlier view append cannot overwrite a later terminal view", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-late-view-"));
  const mock = createMockTroubleshooting();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const allows = mock.ports.authorization.allows;
  let writes = 0;
  mock.ports.authorization.allows = async (action, authority) => {
    if (action === "records.append" && writes++ === 0) { entered.resolve(); await release.promise; }
    return allows(action, authority);
  };
  let store: SqliteRecords | undefined;
  try {
    store = new SqliteRecords(directory, mock.ports);
    await store.admission.confirm({ key: "e".repeat(64), caseRef: "case-1", principalRef: actor.principalRef, initial: { context, view, input: { question: "Why?" } } });
    const old = store.records.append(context, { recordRef: "case-1:old-view", schemaVersion: 1, kind: "view", payload: view });
    await entered.promise;
    await store.records.append(context, { recordRef: "case-1:terminal-view", schemaVersion: 1, kind: "view", payload: { ...view, state: "stopped", stopReason: "cancelled" } });
    release.resolve();
    await old;
    const saved = await store.records.read(actor, "case-1");
    assert.ok(saved?.scope === "full");
    assert.equal(saved.view.state, "stopped");
    assert.equal(saved.view.stopReason, "cancelled");
  } finally { release.resolve(); store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Mock C retains the same versioned input and auditable model settlement contract", async () => {
  const mock = createMockTroubleshooting();
  await mock.receive();
  await mock.closed;
  const saved = await mock.ports.records.export(actor, "case-1");
  assert.ok(saved?.scope === "full");
  assert.ok(saved.records.some((entry) => entry.kind === "input" && entry.schemaVersion === 1));
  const model = saved.audits.find((entry) => entry.action === "model.generate" && entry.stage === "complete")!;
  assert.ok(model);
  assert.deepEqual(model.settlement, { source: "mock_usage", state: "settled", reservedMicrousd: 180_000, actualMicrousd: 1_000 });
  assert.doesNotMatch(JSON.stringify(saved), /SYNTHETIC-SECRET/);
});

test("C refuses an unknown or future storage schema instead of creating a fresh ledger over it", async () => {
  for (const format of ["foreign", "future"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "bau-schema-"));
    const mock = createMockTroubleshooting();
    let accidentallyOpened: SqliteRecords | undefined;
    try {
      if (format === "future") new SqliteRecords(directory, mock.ports).close();
      const fixture = new DatabaseSync(join(directory, "records.sqlite"));
      if (format === "foreign") fixture.exec("CREATE TABLE synthetic_other_system(value TEXT); INSERT INTO synthetic_other_system VALUES('synthetic');");
      else fixture.exec("PRAGMA user_version=999;");
      fixture.close();
      await chmod(join(directory, "records.sqlite"), 0o600);
      assert.throws(() => { accidentallyOpened = new SqliteRecords(directory, mock.ports); }, { message: "unavailable" });
    } finally { accidentallyOpened?.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("named SQLite storage and journal files contain no original synthetic identifiers after the complete flow", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-marker-scan-"));
  let store: SqliteRecords | undefined;
  try {
    const mock = createMockTroubleshooting({ controlPorts: (ports) => {
      store = new SqliteRecords(directory, ports);
      return { admission: store.admission, records: store.records, deliveryLedger: store.deliveryLedger, audit: store.audit, budget: store.budget };
    } });
    await mock.receive();
    await mock.closed;
    const scan = childStore(directory, "scan");
    await once(scan.child, "close");
    assert.equal(scan.output(), "clean\n");
    const competing = childStore(directory, "probe");
    await once(competing.child, "close");
    assert.equal(competing.output(), "refused:unavailable\n");
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C append captures owner and payload before asynchronous authorization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-record-snapshot-"));
  const mock = createMockTroubleshooting();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const allows = mock.ports.authorization.allows;
  mock.ports.authorization.allows = async (action, authority) => {
    if (action === "records.append") { entered.resolve(); await release.promise; }
    return allows(action, authority);
  };
  let store: SqliteRecords | undefined;
  try {
    store = new SqliteRecords(directory, mock.ports);
    await store.admission.confirm({ key: "f".repeat(64), caseRef: "case-1", principalRef: actor.principalRef, initial: { context, view, input: { question: "Why?" } } });
    const owner = { ...context };
    const payload = { question: "Original authorized input" };
    const writing = store.records.append(owner, { recordRef: "case-1:snapshot", schemaVersion: 1, kind: "model_input", payload });
    await entered.promise;
    owner.principalRef = "other";
    payload.question = "Changed after the write was requested";
    release.resolve();
    await writing;
    const saved = await store.records.read(actor, "case-1");
    assert.ok(saved?.scope === "full");
    assert.equal((saved.records.find((entry) => entry.recordRef === "case-1:snapshot")!.payload as { question: string }).question, "Original authorized input");
  } finally { release.resolve(); store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("storage refuses a dangling database symlink instead of creating data outside the controlled directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-link-root-"));
  const other = await mkdtemp(join(tmpdir(), "bau-link-target-"));
  let accidentallyOpened: SqliteRecords | undefined;
  try {
    await symlink(join(other, "synthetic.sqlite"), join(directory, "records.sqlite"));
    assert.throws(() => { accidentallyOpened = new SqliteRecords(directory, createMockTroubleshooting().ports); }, { message: "unavailable" });
  } finally { accidentallyOpened?.close(); await rm(directory, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test("C storage and authorization failures expose only a bounded failure code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-safe-errors-"));
  const mock = createMockTroubleshooting();
  let store: SqliteRecords | undefined;
  try {
    assert.throws(() => new SqliteRecords(join(directory, "missing"), mock.ports), { message: "unavailable" });
    store = new SqliteRecords(directory, mock.ports);
    await store.admission.confirm({ key: "1".repeat(64), caseRef: "case-1", principalRef: actor.principalRef, initial: { context, view, input: { question: "Why?" } } });
    mock.ports.authorization.allows = async () => { throw new Error("SYNTHETIC-SECRET-authority-endpoint"); };
    await assert.rejects(store.records.read(actor, "case-1"), { message: "unavailable" });
    await assert.rejects(store.records.export(actor, "case-1"), { message: "unavailable" });
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an audit intent ID replays only the same actor, case and scope binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-intent-binding-"));
  const mock = createMockTroubleshooting();
  let store: SqliteRecords | undefined;
  try {
    store = new SqliteRecords(directory, mock.ports);
    const operation = { ...context, callId: "case-1:phase-1:logs:stable" };
    const details = { scope: { sourceRef: "simulator-source", from: "2026-10-18T00:00:00Z", to: "2026-10-19T00:00:00Z", pageSize: 100 } };
    const receipt = await store.audit.intent(operation, "logs.read", details);
    assert.equal(await store.audit.intent(operation, "logs.read", details), receipt);
    for (const other of [{ ...operation, caseRef: "case-2" }, { ...operation, principalRef: "other" }, { ...operation, resourceRefs: ["other-source"] }]) {
      await assert.rejects(store.audit.intent(other, "logs.read", details), { message: "unavailable" });
    }
    await assert.rejects(store.audit.intent(operation, "logs.read", { scope: { ...details.scope, pageSize: 99 } }), { message: "unavailable" });
    assert.equal(await store.audit.intent(operation, "logs.read", details), receipt);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("A queries before and after clarification use distinct durable read operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-phase-reads-"));
  let store: SqliteRecords | undefined;
  const candidates = [{ applicationId: "SYNTHETIC-SECRET-APPLICATION", submittedAt: "2026-10-18T12:00:00.000Z" },
    { applicationId: "other-application", submittedAt: "2026-10-19T12:00:00.000Z" }];
  try {
    const mock = createMockTroubleshooting({ customerCandidates: candidates, controlPorts: (ports) => {
      store = new SqliteRecords(directory, ports);
      return { admission: store.admission, records: store.records, deliveryLedger: store.deliveryLedger, audit: store.audit, budget: store.budget };
    } });
    await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why is this waiting?" } });
    await mock.phaseClosed(1);
    const waiting = await mock.application.get(actor, "case-1");
    assert.ok("state" in waiting && waiting.state === "awaiting_input");
    await mock.application.provideInformation({ ...actor, eventRef: "reply-1", receivedAt: "2026-10-19T09:01:00.000Z",
      reply: { caseRef: "case-1", questionId: waiting.question!.questionId }, content: { submittedAt: candidates[0]!.submittedAt } });
    await mock.phaseClosed(2);
    const completed = await mock.application.get(actor, "case-1");
    assert.ok("state" in completed && completed.state === "completed");
    const saved = await store!.records.read(actor, "case-1");
    const reads = saved!.audits.filter((entry) => entry.action === "get" && entry.stage === "intent");
    assert.equal(reads.length, 2);
    assert.notEqual(reads[0]!.operationId, reads[1]!.operationId);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C reads and exports multiple accepted records exceeding the individual write limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-record-aggregate-"));
  const reviewer = { principalRef: "reviewer", tenantRef: "tenant-1", destinationRef: "review" };
  const mock = createMockTroubleshooting({ recordGrants: [{ actor: reviewer, role: "business_reviewer", caseRefs: ["case-1"], resourceRefs: ["simulator-source"] }] });
  const store = new SqliteRecords(directory, mock.ports);
  try {
    await store.admission.confirm({ key: "a".repeat(64), caseRef: "case-1", principalRef: actor.principalRef, initial: { context, view, input: { question: "Why?" } } });
    for (const index of [1, 2]) await store.records.append(context, { schemaVersion: 1, recordRef: `case-1:tool-${index}`, kind: "tool_result", payload: "x".repeat(600_000) });
    for (const operation of [store.records.read, store.records.export]) {
      const saved = await operation(actor, "case-1");
      assert.ok(saved?.scope === "full");
      assert.equal(saved.records.filter((item) => item.kind === "tool_result").length, 2);
      const restricted = await operation(reviewer, "case-1");
      assert.ok(restricted?.scope === "report_evidence");
      assert.deepEqual(restricted.records, []);
    }
    await assert.rejects(store.records.append(context, { schemaVersion: 1, recordRef: "case-1:oversized", kind: "tool_result", payload: "x".repeat(1_048_576) }), { message: "unsafe_content" });
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const adapter of ["mock", "sqlite"] as const) test(`C ${adapter} delivery receipt snapshots its addressed key before asynchronous authorization`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-delivery-key-"));
  let store: SqliteRecords | undefined;
  const mock = createMockTroubleshooting({ ...(adapter === "sqlite" ? { controlPorts: (ports) => {
    store = new SqliteRecords(directory, ports); return { admission: store.admission, records: store.records, audit: store.audit,
      deliveryLedger: store.deliveryLedger, budget: store.budget, retention: store.retention };
  } } : {}) });
  try {
    await mock.receive(); await mock.closed;
    const saved = await mock.ports.records.read(mock.inbound, "case-1"); assert.ok(saved?.scope === "full");
    const delivery = saved.deliveries.find((entry) => entry.deliveryKey === "case-1:report:1"); assert.ok(delivery?.bindingRef);
    const query = { caseRef: "case-1", deliveryKey: delivery.deliveryKey, segment: delivery.segment, bindingRef: delivery.bindingRef };
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const allows = mock.ports.authorization.allows; let waiting = true;
    mock.ports.authorization.allows = async (action, authority) => {
      if (action === "records.read" && waiting) { waiting = false; entered.resolve(); await release.promise; }
      return allows(action, authority);
    };
    const pending = mock.ports.deliveryLedger.read(mock.inbound, query); await entered.promise;
    query.caseRef = "foreign-case"; query.deliveryKey = "foreign-case:report:1";
    release.resolve();
    assert.equal((await pending)?.state, "complete");
  } finally { await mock.application.close(); store?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const adapter of ["mock", "sqlite"] as const) test(`C ${adapter} delivery ledger owns typed pending/completed receipts and refuses historical rebinding or revoked recovery`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-delivery-receipt-"));
  const denyActions: string[] = []; let store: SqliteRecords | undefined;
  const mock = createMockTroubleshooting({ denyActions, ...(adapter === "sqlite" ? { controlPorts: (ports) => {
    store = new SqliteRecords(directory, ports); return { admission: store.admission, records: store.records, audit: store.audit,
      deliveryLedger: store.deliveryLedger, budget: store.budget, retention: store.retention };
  } } : {}) });
  try {
    await mock.receive(); await mock.closed;
    const operation = { ...context, callId: "case-1:ledger-direct" };
    const input = { kind: "report" as const, deliveryKey: "case-1:report:direct", segment: 1,
      binding: { destinationRef: actor.destinationRef, caseRef: "case-1", phaseId: 1, text: "Synthetic ledger message." } };
    const begin = await mock.ports.deliveryLedger.begin(operation, input); assert.equal(begin.state, "new"); if (begin.state !== "new") return;
    assert.equal(begin.ticket.completion.confirmed, false);
    const fullRead = mock.ports.records.read;
    mock.ports.records.read = async () => { throw new Error("full_case_disclosure_must_not_be_needed"); };
    assert.deepEqual(await mock.ports.deliveryLedger.read(actor, begin.ticket), { state: "pending" });
    for (const invalid of [{ status: "delivered", caseRef: "foreign-case" }, { status: "delivered", receiptRef: BigInt("9".repeat(64)) }]) {
      await assert.rejects(mock.ports.deliveryLedger.complete(operation, begin.ticket, invalid as never), { message: "invalid_request" });
      assert.deepEqual(await mock.ports.deliveryLedger.read(actor, begin.ticket), { state: "pending" });
      assert.equal(begin.ticket.completion.confirmed, false);
    }
    assert.equal((await mock.ports.deliveryLedger.begin({ ...operation, callId: "case-1:other-call" }, input)).state, "existing");
    assert.deepEqual(await mock.ports.deliveryLedger.begin(operation, { ...input, binding: { ...input.binding, text: "Different message." } }),
      { state: "existing", receipt: { state: "binding_mismatch" }, bindingRef: "1320f282d1c9fc8a1967a4cf39576d843cb9fc2f68452542715c766c5825d289" });
    await mock.ports.deliveryLedger.complete(operation, begin.ticket, { status: "unknown" });
    assert.equal(begin.ticket.completion.confirmed, true);
    assert.deepEqual(await mock.ports.deliveryLedger.read(actor, begin.ticket), { state: "complete", result: { status: "unknown" } });
    await mock.ports.deliveryLedger.complete(operation, begin.ticket, { status: "unknown" });
    await assert.rejects(mock.ports.deliveryLedger.complete(operation, begin.ticket, { status: "delivered" }), { message: "invalid_request" });
    denyActions.push("records.read"); assert.equal(await mock.ports.deliveryLedger.read(actor, begin.ticket), null);
    denyActions.push("delivery.send"); await assert.rejects(mock.ports.deliveryLedger.begin(operation, input), { message: "denied" });
    denyActions.length = 0; mock.ports.records.read = fullRead;
    const saved = await fullRead(actor, "case-1"); assert.ok(saved?.scope === "full");
    assert.deepEqual(saved.audits.filter((entry) => entry.callId === operation.callId && entry.action === "delivery.send").map((entry) => entry.stage), ["intent", "complete"]);
  } finally { await mock.application.close(); store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C typed delivery intent and completion each roll back their ledger row and audit together on SQLite failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-delivery-atomic-")), mock = createMockTroubleshooting();
  let fail: string | undefined;
  const store = new SqliteRecords(directory, mock.ports, { fault: (checkpoint) => { if (checkpoint === fail) throw new Error("synthetic_storage_failure"); } });
  try {
    await store.admission.confirm({ key: "atomic-delivery", caseRef: "case-1", principalRef: actor.principalRef, initial: { context, view, input: { applicationId: "safe-application", question: "Why?" } } });
    const operation = { ...context, callId: "case-1:atomic-send" }, input = { kind: "report" as const, deliveryKey: "case-1:report:atomic", segment: 1,
      binding: { destinationRef: actor.destinationRef, caseRef: "case-1", phaseId: 1, text: "Different message." } };
    const query = { caseRef: "case-1", deliveryKey: input.deliveryKey, segment: 1, bindingRef: "1320f282d1c9fc8a1967a4cf39576d843cb9fc2f68452542715c766c5825d289" };
    fail = "audit:delivery.send:intent";
    await assert.rejects(store.deliveryLedger.begin(operation, input), { message: "audit_unavailable" });
    assert.deepEqual(await store.deliveryLedger.read(actor, query), { state: "absent" });
    fail = undefined;
    const begin = await store.deliveryLedger.begin(operation, input); assert.ok(begin.state === "new");
    fail = "audit:delivery.send:complete";
    await assert.rejects(store.deliveryLedger.complete(operation, begin.ticket, { status: "unknown" }), { message: "audit_unavailable" });
    assert.equal(begin.ticket.completion.confirmed, false);
    assert.deepEqual(await store.deliveryLedger.read(actor, query), { state: "pending" });
    let saved = await store.records.read(actor, "case-1"); assert.ok(saved?.scope === "full");
    assert.deepEqual(saved.audits.filter((entry) => entry.callId === operation.callId).map((entry) => entry.stage), ["intent"]);
    fail = undefined; await store.deliveryLedger.complete(operation, begin.ticket, { status: "unknown" });
    assert.equal(begin.ticket.completion.confirmed, true);
    saved = await store.records.read(actor, "case-1"); assert.ok(saved?.scope === "full");
    assert.deepEqual(saved.audits.filter((entry) => entry.callId === operation.callId).map((entry) => entry.stage), ["intent", "complete"]);
  } finally { store.close(); await mock.application.close(); await rm(directory, { recursive: true, force: true }); }
});
