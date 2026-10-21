import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { SqliteRecords } from "../../src/adapters/records/sqlite.js";
import type { CallContext } from "../../src/troubleshooting/application/ports.js";
import type { Retention } from "../../src/troubleshooting/application/retention.js";
import { legacyBudget2 } from "../fixtures/legacy-records.js";
import { ManualClock } from "../fixtures/clock.js";
import type { RetentionTriggerKind } from "../../src/troubleshooting/application/retention.js";

const lifecycleActor = { principalRef: "lifecycle-owner", tenantRef: "tenant-1", destinationRef: "lifecycle-path" };

test("C records every authorized project decision with the exact UTC thirty-day cutoff and immutable replay", async () => {
  for (const kind of ["mvp_accepted", "poc_no_go", "terminated", "no_mvp"] as const satisfies readonly RetentionTriggerKind[]) {
    const mock = createMockTroubleshooting({ ...{ lifecycleActors: [lifecycleActor] }, clock: new ManualClock() });
    const retention = mock.ports.retention!;
    const trigger = { triggerRef: "decision-1", kind, decidedAt: "2026-10-19T09:00:00.000Z", scope: "poc" as const };
    const first = await retention.recordTrigger(lifecycleActor, trigger);
    assert.equal(first.state, "scheduled");
    assert.equal(first.dueAt, "2026-11-18T09:00:00.000Z");
    assert.deepEqual(await retention.recordTrigger(lifecycleActor, trigger), first);
    await assert.rejects(retention.recordTrigger(lifecycleActor, { ...trigger, decidedAt: "2026-10-18T09:00:00.000Z" }), { message: "invalid_request" });
    assert.equal((await retention.purgeDue(lifecycleActor)).state, "scheduled");
  }
});


test("C keeps the earliest project cutoff across later decisions and native restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-retention-restart-"));
  const clock = new ManualClock();
  const mock = createMockTroubleshooting({ lifecycleActors: [lifecycleActor], clock });
  let store = new SqliteRecords(directory, mock.ports);
  try {
    let retention = (store as unknown as { retention: Retention }).retention;
    await retention.recordTrigger(lifecycleActor, { triggerRef: "no-go", kind: "poc_no_go", decidedAt: clock.utc(), scope: "poc" });
    clock.advance(86_400_000);
    await retention.recordTrigger(lifecycleActor, { triggerRef: "mvp", kind: "mvp_accepted", decidedAt: clock.utc(), scope: "poc" });
    store.close();
    store = new SqliteRecords(directory, mock.ports);
    retention = (store as unknown as { retention: Retention }).retention;
    const status = await retention.deletionStatus(lifecycleActor);
    assert.equal(status.dueAt, "2026-11-18T09:00:00.000Z");
    assert.equal(status.triggers.length, 2);
    await assert.rejects(retention.deletionStatus(mock.inbound), { message: "denied" });
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C closes and purges Mock records at the exact cutoff while retaining cost and denying old A views", async () => {
  const clock = new ManualClock();
  const mock = createMockTroubleshooting({ lifecycleActors: [lifecycleActor], clock });
  await mock.receive(); await mock.closed;
  const retention = mock.ports.retention!;
  await retention.recordTrigger(lifecycleActor, { triggerRef: "stop", kind: "terminated", decidedAt: clock.utc(), scope: "poc" });
  clock.advance(30 * 86_400_000 - 1);
  assert.equal((await retention.purgeDue(lifecycleActor)).state, "scheduled");
  assert.ok(await mock.ports.records.read(mock.inbound, "case-1"));
  clock.advance(1);
  const deleted = await retention.purgeDue(lifecycleActor);
  assert.equal(deleted.state, "deleted", JSON.stringify(deleted.receipt));
  assert.equal(deleted.receipt?.result, "deleted");
  assert.equal(deleted.receipt?.completedAt, "2026-11-18T09:00:00.000Z");
  assert.deepEqual(await retention.purgeDue(lifecycleActor), deleted);
  assert.equal(await mock.ports.records.read(mock.inbound, "case-1"), null);
  assert.equal(await mock.ports.records.export(mock.inbound, "case-1"), null);
  assert.deepEqual(await mock.application.get(mock.inbound, "case-1"), { status: "denied" });
  assert.deepEqual(await mock.application.cancel(mock.inbound, "case-1"), { status: "denied" });
  assert.deepEqual(await mock.receive(), { status: "service_unavailable", reason: "unavailable" });
  assert.equal((await mock.ports.budget.status("case-1")).pocMicrousd, 1_000);
});


test("C native purge removes full records and named-file residues while preserving unknown fees, slots and original settlement binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-retention-native-"));
  const clock = new ManualClock();
  const marker = "CONTROLLED-DELETE-CONTENT-42";
  let context: CallContext | undefined;
  let store: SqliteRecords | undefined;
  const mock = createMockTroubleshooting({ lifecycleActors: [lifecycleActor], clock,
    model: async (call, draft) => { context = call; return { candidate: draft, actualMicrousd: null }; },
    controlPorts: (ports) => {
      store = new SqliteRecords(directory, ports);
      return { admission: store.admission, audit: store.audit, records: store.records, budget: store.budget, retention: store.retention };
    } });
  try {
    await mock.receive({ input: { applicationId: "SYNTHETIC-SECRET-APPLICATION", question: marker } }); await mock.closed;
    assert.ok(context);
    const scan = () => spawnSync(process.execPath, [new URL("../fixtures/sqlite-process.js", import.meta.url).pathname, directory, "scan", marker,
      "principal-1", "tenant-1", "private-conversation-1"], { encoding: "utf8", timeout: 5_000 });
    assert.equal(scan().status, 1);
    const first = { ...context, signal: new AbortController().signal, callId: "case-1:unknown-first", operationRef: "case-1:unknown-first" };
    const second = { ...first, callId: "case-1:unknown-second", operationRef: "case-1:unknown-second" };
    assert.equal(await mock.ports.budget.reserve(first, 180_000), true);
    assert.equal(await mock.ports.budget.reserve(second, 180_000), true);
    await store!.retention.recordTrigger(lifecycleActor, { triggerRef: "no-go", kind: "poc_no_go", decidedAt: clock.utc(), scope: "poc" });
    clock.advance(30 * 86_400_000);
    const deleted = await store!.retention.purgeDue(lifecycleActor);
    assert.equal(deleted.state, "deleted", JSON.stringify(deleted.receipt));
    assert.ok(deleted.receipt?.checks.some((check) => check.scope === "sqlite" && check.verification.includes("freePages=0")));
    assert.equal(await store!.records.export(mock.inbound, "case-1"), null);
    assert.deepEqual(await mock.application.get(mock.inbound, "case-1"), { status: "denied" });
    assert.equal((await store!.budget.status("case-1")).pocMicrousd, 540_000);
    assert.equal((await store!.budget.status("case-1")).unsettledCalls, 2);
    await store!.budget.settle(first, 1_000);
    await store!.budget.settle(first, 1_000);
    assert.equal((await store!.budget.status("case-1")).pocMicrousd, 361_000);
    assert.equal((await store!.budget.status("case-1")).unsettledCalls, 1);
    assert.equal(await store!.budget.reserve({ ...second, callId: "new-after-purge", deadline: clock.now() + 60_000 }, 1), false);
    for (const name of await readdir(directory)) {
      const bytes = await readFile(join(directory, name));
      for (const removed of [marker, "principal-1", "tenant-1", "private-conversation-1"]) assert.equal(bytes.includes(Buffer.from(removed)), false, `${name}: ${removed}`);
    }
    assert.equal((await readdir(directory)).some((name) => /^records\.sqlite-(journal|wal|shm)$/.test(name)), false);
    const afterScan = scan();
    assert.equal(afterScan.status, 0);
    assert.equal(afterScan.stdout, "clean\n");
    store!.close();
    store = new SqliteRecords(directory, mock.ports);
    assert.equal((await store.retention.deletionStatus(lifecycleActor)).state, "deleted");
    assert.equal(await store.records.read(mock.inbound, "case-1"), null);
    assert.equal((await store.budget.status("case-1")).pocMicrousd, 361_000);
    assert.equal((await store.budget.status("case-1")).unsettledCalls, 1);
    assert.equal(await store.budget.reserve({ ...second, callId: "restart-after-purge", deadline: clock.now() + 60_000 }, 1), false);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});


test("C native purge covers every explicitly verified local copy and reports their scoped deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-retention-copies-"));
  const clock = new ManualClock();
  const mock = createMockTroubleshooting({ lifecycleActors: [lifecycleActor], clock });
  const copies = (["temporary", "backup", "host_copy"] as const).map((kind) => ({ copyRef: kind, kind, verificationRef: "synthetic-local-private-files-1" as const }));
  let store: SqliteRecords | undefined;
  try {
    for (const copy of copies) {
      const path = join(directory, "controlled-copies", copy.copyRef);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await writeFile(join(path, "synthetic-copy.json"), "CONTROLLED-COPY-DELETE-MARKER", { mode: 0o600 });
    }
    store = new SqliteRecords(directory, mock.ports, { ...{ controlledCopies: copies }, fault: () => {} });
    await store.retention.recordTrigger(lifecycleActor, { triggerRef: "stop", kind: "no_mvp", decidedAt: "2026-09-19T09:00:00.000Z", scope: "poc" });
    const result = await store.retention.purgeDue(lifecycleActor);
    assert.equal(result.state, "deleted", JSON.stringify(result.receipt));
    for (const copy of copies) {
      assert.ok(result.receipt?.checks.some((check) => check.scope === `copy:${copy.copyRef}` && check.result === "deleted"));
      await assert.rejects(access(join(directory, "controlled-copies", copy.copyRef)));
    }
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C refuses unverified backup or snapshot profiles without retaining the runtime lock", async () => {
  for (const copy of [
    { copyRef: "unverified-backup", kind: "backup" as const, verificationRef: "unverified" as never },
    { copyRef: "host-snapshot", kind: "snapshot" as never, verificationRef: "synthetic-local-private-files-1" as const },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "bau-retention-disabled-copy-"));
    const mock = createMockTroubleshooting({ lifecycleActors: [lifecycleActor] });
    let store: SqliteRecords | undefined;
    try {
      assert.throws(() => { store = new SqliteRecords(directory, mock.ports, { controlledCopies: [copy] }); }, { message: "unavailable" });
      store = new SqliteRecords(directory, mock.ports);
      assert.equal((await store.retention.deletionStatus(lifecycleActor)).state, "untriggered");
    } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("purge invalidates an A get whose audit was already written but whose result has not been disclosed", async () => {
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting({ lifecycleActors: [lifecycleActor], controlPorts: (ports) => {
    const audit = ports.audit;
    return { audit: { ...audit, complete: async (context, action, outcome, details) => {
      await audit.complete(context, action, outcome, details);
      if (action === "get") { ready.resolve(); await release.promise; }
    } } };
  } });
  try {
    await mock.receive(); await mock.closed;
    const reading = mock.application.get(mock.inbound, "case-1");
    await ready.promise;
    await mock.ports.retention!.recordTrigger(lifecycleActor, { triggerRef: "stop", kind: "terminated", decidedAt: "2026-09-19T09:00:00.000Z", scope: "poc" });
    assert.equal((await mock.ports.retention!.purgeDue(lifecycleActor)).state, "deleted");
    release.resolve();
    assert.deepEqual(await reading, { status: "denied" });
  } finally { release.resolve(); }
});

for (const durable of [false, true]) test(`${durable ? "SQLite" : "Mock"} purge also invalidates C export while its final authorization is pending`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-export-purge-race-"));
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let store: SqliteRecords | undefined;
  let exports = 0;
  const mock = createMockTroubleshooting({ lifecycleActors: [lifecycleActor], controlPorts: (ports) => {
    const allows = ports.authorization.allows;
    ports.authorization.allows = async (action, context) => {
      const allowed = await allows(action, context);
      if (action === "records.export" && ++exports === 2) { ready.resolve(); await release.promise; }
      return allowed;
    };
    if (!durable) return {};
    store = new SqliteRecords(directory, ports);
    return { admission: store.admission, records: store.records, audit: store.audit, budget: store.budget, retention: store.retention };
  } });
  try {
    await mock.receive(); await mock.closed;
    const pending = mock.ports.records.export(mock.inbound, "case-1");
    await ready.promise;
    await mock.ports.retention!.recordTrigger(lifecycleActor, { triggerRef: "stop", kind: "terminated", decidedAt: "2026-09-19T09:00:00.000Z", scope: "poc" });
    await mock.ports.retention!.purgeDue(lifecycleActor);
    release.resolve();
    assert.equal((await pending) === null, true);
  } finally { release.resolve(); store?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const failure of ["retention:delete:before_commit", "retention:vacuum:before", "retention:copy:backup:before"] as const) test(`C deletion failure at ${failure} stays closed, reports partial progress and can be retried after restart`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-retention-fault-"));
  const clock = new ManualClock();
  let fail = false;
  let store: SqliteRecords | undefined;
  const copy = { copyRef: "backup", kind: "backup" as const, verificationRef: "synthetic-local-private-files-1" as const };
  const mock = createMockTroubleshooting({ clock, lifecycleActors: [lifecycleActor], controlPorts: (ports) => {
    store = new SqliteRecords(directory, ports, { controlledCopies: [copy], fault: (point) => { if (fail && point === failure) throw new Error("synthetic I/O error"); } });
    return { admission: store.admission, records: store.records, audit: store.audit, budget: store.budget, retention: store.retention };
  } });
  try {
    await mkdir(join(directory, "controlled-copies", "backup"), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "controlled-copies", "backup", "copy"), "CONTROLLED-PARTIAL-COPY", { mode: 0o600 });
    await mock.receive(); await mock.closed;
    await store!.retention.recordTrigger(lifecycleActor, { triggerRef: "stop", kind: "no_mvp", decidedAt: "2026-09-19T09:00:00.000Z", scope: "poc" });
    fail = true;
    const partial = await store!.retention.purgeDue(lifecycleActor);
    assert.equal(partial.state, "partial");
    assert.ok(partial.receipt?.checks.some((check) => check.result === "failed"));
    assert.equal(partial.receipt?.result, "partial");
    assert.equal(await store!.records.read(mock.inbound, "case-1"), null);
    assert.equal((await store!.budget.status("case-1")).pocMicrousd, 1_000);
    store!.close();
    store = new SqliteRecords(directory, mock.ports, { controlledCopies: [copy] });
    assert.equal((await store.retention.deletionStatus(lifecycleActor)).state, "partial");
    assert.equal((await store.retention.purgeDue(lifecycleActor)).state, "deleted");
    await assert.rejects(access(join(directory, "controlled-copies", "backup")));
    assert.equal((await store.budget.status("case-1")).pocMicrousd, 1_000);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C never reports deletion success if its durable final receipt commit fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-retention-receipt-fault-"));
  const clock = new ManualClock();
  const mock = createMockTroubleshooting({ clock, lifecycleActors: [lifecycleActor] });
  let store = new SqliteRecords(directory, mock.ports, { fault: (point) => {
    if (point === "retention:state:deleted:before_commit") throw new Error("synthetic receipt disk error");
  } });
  try {
    await store.retention.recordTrigger(lifecycleActor, { triggerRef: "stop", kind: "no_mvp", decidedAt: "2026-09-19T09:00:00.000Z", scope: "poc" });
    await assert.rejects(store.retention.purgeDue(lifecycleActor), { message: "unavailable" });
    assert.equal((await store.retention.deletionStatus(lifecycleActor)).state, "deleting");
    store.close(); store = new SqliteRecords(directory, mock.ports);
    assert.equal((await store.retention.deletionStatus(lifecycleActor)).state, "deleting");
    assert.equal((await store.retention.purgeDue(lifecycleActor)).state, "deleted");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const durable of [false, true]) test(`${durable ? "SQLite" : "Mock"} late model completion after purge can settle the original fee but cannot restore records or send`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-purge-late-model-"));
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const clock = new ManualClock();
  let store: SqliteRecords | undefined;
  const mock = createMockTroubleshooting({ clock, lifecycleActors: [lifecycleActor], model: async (_context, draft) => {
    started.resolve(); await finish.promise; return { candidate: draft, actualMicrousd: 1_000 };
  }, controlPorts: (ports) => {
    if (!durable) return {};
    store = new SqliteRecords(directory, ports);
    return { admission: store.admission, records: store.records, audit: store.audit, budget: store.budget, retention: store.retention };
  } });
  try {
    await mock.receive(); await started.promise;
    await mock.ports.retention!.recordTrigger(lifecycleActor, { triggerRef: "stop", kind: "terminated", decidedAt: "2026-09-19T09:00:00.000Z", scope: "poc" });
    const purge = mock.ports.retention!.purgeDue(lifecycleActor);
    await new Promise((resolve) => setImmediate(resolve)); clock.advance(5_000);
    assert.equal((await purge).state, "partial");
    assert.equal((await mock.ports.budget.status("case-1")).unsettledCalls, 1);
    assert.equal((await mock.ports.budget.status("case-1")).pocMicrousd, 180_000);
    finish.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await mock.ports.retention!.purgeDue(lifecycleActor)).state, "deleted");
    assert.equal((await mock.ports.budget.status("case-1")).pocMicrousd, 1_000);
    assert.equal((await mock.ports.budget.status("case-1")).unsettledCalls, 0);
    assert.equal(await mock.ports.records.export(mock.inbound, "case-1"), null);
    assert.equal(mock.events.some((event) => event.action === "delivery.send" || event.action === "delivery.fault"), false);
    assert.deepEqual(await mock.application.get(mock.inbound, "case-1"), { status: "denied" });
  } finally { finish.resolve(); store?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const durable of [false, true]) test(`${durable ? "SQLite" : "Mock"} an observed UTC expiry remains closed after wall rollback and restart`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-retention-clock-"));
  let wall = "2026-10-19T09:00:00.000Z";
  const clock = { now: () => 0, utc: () => wall };
  let store: SqliteRecords | undefined;
  const mock = createMockTroubleshooting({ lifecycleActors: [lifecycleActor], clock, controlPorts: (ports) => {
    if (!durable) return {};
    store = new SqliteRecords(directory, ports);
    return { admission: store.admission, records: store.records, audit: store.audit, budget: store.budget, retention: store.retention };
  } });
  try {
    await mock.receive(); await mock.closed;
    await mock.ports.retention!.recordTrigger(lifecycleActor, { triggerRef: "stop", kind: "no_mvp", decidedAt: wall, scope: "poc" });
    wall = "2026-11-18T09:00:00.000Z";
    assert.equal(await mock.ports.records.read(mock.inbound, "case-1"), null);
    wall = "2026-11-17T09:00:00.000Z";
    assert.equal((await mock.ports.records.export(mock.inbound, "case-1")) === null, true);
    assert.deepEqual(await mock.application.get(mock.inbound, "case-1"), { status: "denied" });
    if (store) {
      store.close(); store = new SqliteRecords(directory, mock.ports);
      assert.equal((await store.records.read(mock.inbound, "case-1")) === null, true);
      assert.equal((await store.retention.purgeDue(lifecycleActor)).state, "deleted");
    } else assert.equal((await mock.ports.retention!.purgeDue(lifecycleActor)).state, "deleted");
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});


test("C refuses a dangling controlled-copy root instead of treating the uninspected path as absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-retention-dangling-copy-"));
  const mock = createMockTroubleshooting();
  let store: SqliteRecords | undefined;
  try {
    await symlink(join(directory, "missing"), join(directory, "controlled-copies"));
    assert.throws(() => { store = new SqliteRecords(directory, mock.ports); }, { message: "unavailable" });
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C deletion uses the database's canonical controlled root when a parent alias is redirected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-retention-canonical-"));
  const original = join(directory, "first", "store");
  const other = join(directory, "second", "store");
  const alias = join(directory, "alias");
  const copy = { copyRef: "temporary", kind: "temporary" as const, verificationRef: "synthetic-local-private-files-1" as const };
  const mock = createMockTroubleshooting({ lifecycleActors: [lifecycleActor] });
  let store: SqliteRecords | undefined;
  try {
    for (const root of [original, other]) {
      await mkdir(join(root, "controlled-copies", "temporary"), { recursive: true, mode: 0o700 });
      await writeFile(join(root, "controlled-copies", "temporary", "copy"), "CONTROLLED-ALIAS-OTHER-DATA", { mode: 0o600 });
    }
    await symlink(join(directory, "first"), alias);
    store = new SqliteRecords(join(alias, "store"), mock.ports, { controlledCopies: [copy] });
    await store.retention.recordTrigger(lifecycleActor, { triggerRef: "stop", kind: "terminated", decidedAt: "2026-09-19T09:00:00.000Z", scope: "poc" });
    await unlink(alias); await symlink(join(directory, "second"), alias);
    assert.equal((await store.retention.purgeDue(lifecycleActor)).state, "deleted");
    await assert.rejects(access(join(original, "controlled-copies", "temporary")));
    assert.equal(await readFile(join(other, "controlled-copies", "temporary", "copy"), "utf8"), "CONTROLLED-ALIAS-OTHER-DATA");
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C lifecycle fences synchronous and rejected authorization faults and releases bounded control positions", async () => {
  let fail: "sync" | "async" | null = "sync";
  const mock = createMockTroubleshooting({ lifecycleActors: [lifecycleActor], controlPorts: (ports) => {
    const allows = ports.authorization.allows;
    ports.authorization.allows = (action, context) => {
      if (action.startsWith("retention.") && fail === "sync") throw new Error("SYNTHETIC-SECRET /private/unapproved/path");
      if (action.startsWith("retention.") && fail === "async") return Promise.reject(new Error("SYNTHETIC-SECRET /private/unapproved/path"));
      return allows(action, context);
    };
    return {};
  } });
  const retention = mock.ports.retention!;
  const trigger = { triggerRef: "stop", kind: "no_mvp" as const, decidedAt: "2026-10-19T09:00:00.000Z", scope: "poc" as const };
  for (const kind of ["sync", "async"] as const) {
    fail = kind;
    for (let index = 0; index < 33; index++) await assert.rejects(retention.recordTrigger(lifecycleActor, trigger), { message: "unavailable" });
    await assert.rejects(retention.purgeDue(lifecycleActor), { message: "unavailable" });
    await assert.rejects(retention.deletionStatus(lifecycleActor), { message: "unavailable" });
  }
  fail = null;
  assert.equal((await retention.recordTrigger(lifecycleActor, trigger)).state, "scheduled");
});

test("A fails closed with structured safe replies when its host retention load becomes unavailable", async () => {
  let fail = false;
  const mock = createMockTroubleshooting({ controlPorts: (ports) => ({ retention: new Proxy(ports.retention!, {
    get(target, key) {
      if (key === "closed") return () => { if (fail) throw new Error("SYNTHETIC-SECRET /private/storage/path"); return target.closed(); };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) }) });
  await mock.receive(); await mock.closed;
  fail = true;
  assert.deepEqual(await mock.application.get(mock.inbound, "case-1"), { status: "denied" });
  assert.deepEqual(await mock.application.cancel(mock.inbound, "case-1"), { status: "denied" });
  assert.deepEqual(await mock.receive({ eventRef: "new-event" }), { status: "service_unavailable", reason: "unavailable" });
});

test("purge returns within five seconds but retries cannot claim runtime closure while the original close is unconfirmed", async () => {
  const clock = new ManualClock();
  const started = Promise.withResolvers<void>();
  const finishModel = Promise.withResolvers<void>();
  const closeRuntime = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting({ clock, lifecycleActors: [lifecycleActor], model: async (_context, draft) => {
    started.resolve(); await finishModel.promise; return { candidate: draft, actualMicrousd: null };
  }, controlPorts: (ports) => {
    const close = ports.agent.close;
    ports.agent.abort = () => closeRuntime.promise;
    ports.agent.close = async (caseRef, phase) => { await closeRuntime.promise; await close(caseRef, phase); };
    return {};
  } });
  try {
    await mock.receive(); await started.promise;
    await mock.ports.retention!.recordTrigger(lifecycleActor, { triggerRef: "stop", kind: "no_mvp", decidedAt: "2026-09-19T09:00:00.000Z", scope: "poc" });
    const first = mock.ports.retention!.purgeDue(lifecycleActor);
    await new Promise((resolve) => setImmediate(resolve)); clock.advance(5_000);
    assert.equal((await first).state, "partial");
    const second = mock.ports.retention!.purgeDue(lifecycleActor);
    await new Promise((resolve) => setImmediate(resolve)); clock.advance(5_000);
    assert.equal((await second).state, "partial");
    closeRuntime.resolve(); finishModel.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await mock.ports.retention!.purgeDue(lifecycleActor)).state, "deleted");
  } finally { closeRuntime.resolve(); finishModel.resolve(); }
});


test("schema-2 binding minimization migrates atomically without losing original-call idempotence or unknown fees", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-retention-migrate-"));
  const clock = new ManualClock();
  const mock = createMockTroubleshooting({ clock, lifecycleActors: [lifecycleActor] });
  const context: CallContext = { principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1",
    caseRef: "case-1", phaseId: 1, callId: "case-1:phase-1:known", resourceRefs: ["simulator-source"], policyVersion: "mock-policy-1",
    approvalRef: "mock-approval-1", snapshotRef: "simulator-snapshot-1", budgetRef: "case-1", deadline: 180_000, signal: new AbortController().signal };
  let store: SqliteRecords | undefined;
  try {
    legacyBudget2(directory, context);
    assert.throws(() => { store = new SqliteRecords(directory, mock.ports, { fault: (point) => {
      if (point === "retention:migrate:before_commit") throw new Error("synthetic migration I/O");
    } }); }, { message: "unavailable" });
    store = new SqliteRecords(directory, mock.ports);
    assert.equal(await store.budget.reserve(context, 180_000), true);
    assert.equal((await store.budget.status("case-1")).pocMicrousd, 364_000);
    assert.equal((await store.budget.status("case-1")).unsettledCalls, 2);
    await store.budget.settle({ ...context, callId: "case-1:phase-1:unknown" }, null, { source: "unknown", execution: "ended" });
    assert.equal((await store.budget.status("case-1")).pocMicrousd, 364_000);
    assert.equal((await store.budget.status("case-1")).unsettledCalls, 1);
    await store.retention.recordTrigger(lifecycleActor, { triggerRef: "stop", kind: "terminated", decidedAt: "2026-09-19T09:00:00.000Z", scope: "poc" });
    assert.equal((await store.retention.purgeDue(lifecycleActor)).state, "deleted");
    for (const name of await readdir(directory)) assert.equal((await readFile(join(directory, name))).includes(Buffer.from("private-conversation-1")), false);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C lifecycle rejects unauthorized, malformed, future and non-UTC decisions without creating a deadline", async () => {
  const mock = createMockTroubleshooting({ lifecycleActors: [lifecycleActor] });
  const retention = mock.ports.retention!;
  const trigger = { triggerRef: "stop", kind: "no_mvp" as const, decidedAt: "2026-10-19T09:00:00.000Z", scope: "poc" as const };
  await assert.rejects(retention.recordTrigger(mock.inbound, trigger), { message: "denied" });
  for (const decidedAt of ["2026-10-20T09:00:00.000Z", "2026-02-30T00:00:00.000Z", "2026-10-19T17:00:00.000+08:00", "unknown"]) {
    await assert.rejects(retention.recordTrigger(lifecycleActor, { ...trigger, decidedAt }), { message: "invalid_request" });
  }
  await assert.rejects(retention.recordTrigger(lifecycleActor, { ...trigger, kind: "extend_forever" as never }), { message: "invalid_request" });
  assert.equal((await retention.deletionStatus(lifecycleActor)).state, "untriggered");
});

test("C lifecycle control waits are bounded and late authorization cannot register an expired request", async () => {
  const clock = new ManualClock();
  const release = Promise.withResolvers<boolean>();
  let stalled = true;
  let calls = 0;
  const mock = createMockTroubleshooting({ clock, lifecycleActors: [lifecycleActor], controlPorts: (ports) => {
    const allows = ports.authorization.allows;
    ports.authorization.allows = (action, context) => {
      if (stalled && action.startsWith("retention.")) { calls++; return release.promise; }
      return allows(action, context);
    };
    return {};
  } });
  const retention = mock.ports.retention!;
  const trigger = { triggerRef: "stop", kind: "no_mvp" as const, decidedAt: clock.utc(), scope: "poc" as const };
  const pending = Array.from({ length: 32 }, () => assert.rejects(retention.recordTrigger(lifecycleActor, trigger), { message: "timeout" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 32);
  await assert.rejects(retention.recordTrigger(lifecycleActor, trigger), { message: "unavailable" });
  clock.advance(5_000);
  await Promise.all(pending);
  await assert.rejects(retention.deletionStatus(lifecycleActor), { message: "unavailable" });
  stalled = false; release.resolve(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await retention.deletionStatus(lifecycleActor)).state, "untriggered");
});

test("the Agent cannot invoke record export or retention deletion even by naming the lifecycle actor", async () => {
  for (const tool of ["records.export", "retention.recordTrigger", "retention.purgeDue"]) {
    const mock = createMockTroubleshooting({ lifecycleActors: [lifecycleActor], agent: async (_context, request) => request.invoke(tool,
      { actor: lifecycleActor, kind: "no_mvp", scope: "poc" }) });
    await mock.receive(); await mock.closed;
    assert.equal((await mock.ports.retention!.deletionStatus(lifecycleActor)).state, "untriggered");
    assert.equal(mock.events.some((event) => ["logs.read", "model.generate", "delivery.send"].includes(event.action)), false);
    const result = await mock.application.get(mock.inbound, "case-1");
    assert.ok("state" in result && result.stopReason === "denied");
  }
});

for (const durable of [false, true]) test(`${durable ? "SQLite" : "Mock"} status polling latches observed expiry across UTC rollback`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-status-expiry-"));
  const clock = new ManualClock();
  let utc = "2026-10-19T09:00:00.000Z";
  clock.utc = () => utc;
  let store: SqliteRecords | undefined;
  const mock = createMockTroubleshooting({ clock, lifecycleActors: [lifecycleActor], controlPorts: (ports) => {
    if (!durable) return {};
    store = new SqliteRecords(directory, ports);
    return { admission: store.admission, records: store.records, audit: store.audit, budget: store.budget, retention: store.retention };
  } });
  try {
    await mock.receive(); await mock.closed;
    const retention = mock.ports.retention!;
    await retention.recordTrigger(lifecycleActor, { triggerRef: "expiry", kind: "terminated", decidedAt: utc, scope: "poc" });
    utc = "2026-11-18T09:00:00.000Z";
    assert.equal((await retention.deletionStatus(lifecycleActor)).closedAt, utc);
    utc = "2026-10-19T09:00:00.000Z";
    assert.equal(retention.closed(), true);
    assert.equal(await mock.ports.records.read(mock.inbound, "case-1"), null);
    assert.equal((await mock.receive({ eventRef: "after-expiry" })).status, "service_unavailable");
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});
