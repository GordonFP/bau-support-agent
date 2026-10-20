import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRecords } from "../../src/adapters/records/sqlite.js";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import type { CallContext } from "../../src/troubleshooting/application/ports.js";
import { ManualClock } from "../fixtures/clock.js";
import type { ModelEnvelope } from "../../src/troubleshooting/application/model-contract.js";
import { ModelFailure } from "../../src/troubleshooting/application/model-failure.js";
import { legacyRecords } from "../fixtures/legacy-records.js";

const call = (caseRef: string, callId: string): CallContext => ({ caseRef, phaseId: 1, callId, principalRef: "principal-1", tenantRef: "tenant-1",
  destinationRef: "private-conversation-1", policyVersion: "mock-policy-1", approvalRef: "mock-approval-1", resourceRefs: ["simulator-source"],
  snapshotRef: "simulator-snapshot-1", budgetRef: caseRef, deadline: 180_000, signal: new AbortController().signal });

test("C atomically admits only one contender for the last case dollars and rejects cross-case reuse of its call ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-budget-case-"));
  const controls = createMockTroubleshooting().ports;
  let store = new SqliteRecords(directory, controls);
  try {
    const first = call("case-1", "call-1");
    const second = call("case-1", "call-2");
    assert.deepEqual(await Promise.all([store.budget.reserve(first, 1_100_000), store.budget.reserve(second, 1_100_000)]), [true, false]);
    assert.equal((await store.budget.status("case-1")).reservedMicrousd, 1_100_000);
    assert.equal(await store.budget.reserve(first, 1_100_000), true);
    assert.equal(await store.budget.reserve({ ...first, caseRef: "case-2" }, 1_100_000), false);
    store.close();
    store = new SqliteRecords(directory, controls);
    for (const conflicting of [{ ...first, phaseId: 2 }, { ...first, principalRef: "other" }, { ...first, resourceRefs: ["other-source"] }]) {
      assert.equal(await store.budget.reserve(conflicting, 1_100_000), false);
    }
    assert.equal(await store.budget.reserve(first, 1_100_000), true);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C retains the six-attempt allowance across phases and exact budget boundaries use integer units", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-budget-attempts-"));
  const clock = new ManualClock();
  const store = new SqliteRecords(directory, createMockTroubleshooting({ clock }).ports);
  try {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const context = { ...call("case-1", `attempt-${attempt}`), phaseId: attempt };
      assert.equal(await store.budget.reserve(context, 180_000), true);
      await store.budget.settle(context, 1_000);
    }
    assert.equal(await store.budget.reserve(call("case-1", "seventh"), 180_000), false);
    clock.advance(60_000);
    assert.equal(await store.budget.reserve(call("exact", "exact"), 2_000_000), true);
    assert.equal(await store.budget.reserve(call("over", "over"), 2_000_001), false);
    await assert.rejects(store.budget.reserve(call("fraction", "fraction"), 0.1), { message: "invalid_request" });
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C queues a third unconfirmed execution until an original call actually ends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-budget-slots-"));
  const clock = new ManualClock();
  const store = new SqliteRecords(directory, createMockTroubleshooting({ clock }).ports);
  try {
    const first = call("one", "one");
    assert.equal(await store.budget.reserve(first, 180_000), true);
    assert.equal(await store.budget.reserve(call("two", "two"), 180_000), true);
    let admitted = false;
    const third = store.budget.reserve(call("three", "three"), 180_000).then((result) => { admitted = result; return result; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(admitted, false);
    await store.budget.settle(first, 1_000);
    assert.equal(await third, true);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C admits at most six starts in a rolling 60 seconds rather than a minute bucket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-budget-rate-"));
  const clock = new ManualClock();
  const controls = createMockTroubleshooting({ clock }).ports;
  let store = new SqliteRecords(directory, controls);
  try {
    clock.advance(59_000);
    for (let attempt = 1; attempt <= 6; attempt++) {
      const context = call(`case-${attempt}`, `call-${attempt}`);
      assert.equal(await store.budget.reserve(context, 180_000), true);
      await store.budget.settle(context, 1_000);
    }
    store.close();
    store = new SqliteRecords(directory, controls);
    assert.equal((await store.budget.status("case-1")).startsLast60s, 6);
    let started = false;
    const queued = store.budget.reserve(call("seventh", "seventh"), 180_000).then((value) => { started = value; return value; });
    clock.advance(59_999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, false);
    clock.advance(1);
    assert.equal(await queued, true);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a confirmed end with missing usage releases execution capacity while retaining the entire fee reserve", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-budget-unknown-fee-"));
  const store = new SqliteRecords(directory, createMockTroubleshooting().ports);
  try {
    const first = call("one", "one");
    await store.budget.reserve(first, 180_000);
    await store.budget.reserve(call("two", "two"), 180_000);
    await store.budget.settle(first, null, { execution: "ended", source: "unknown" });
    assert.equal((await store.budget.status("one")).reservedMicrousd, 180_000);
    let started = false;
    const third = store.budget.reserve(call("three", "three"), 180_000).then((value) => { started = value; return value; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, true);
    assert.equal(await third, true);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("estimated or zero-filled usage retains reserve until an actual source reconciles the original call once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-budget-estimate-"));
  const store = new SqliteRecords(directory, createMockTroubleshooting().ports);
  try {
    const context = call("case-1", "original");
    await store.budget.reserve(context, 180_000);
    await store.budget.settle(context, 0, { execution: "ended", source: "estimated" });
    assert.equal((await store.budget.status("case-1")).reservedMicrousd, 180_000);
    assert.deepEqual((await store.budget.status("case-1")).charges?.[0], { callId: "original", reservedMicrousd: 180_000,
      actualMicrousd: null, estimatedMicrousd: 0, source: "estimated", execution: "ended" });
    await store.budget.settle(context, 0, { execution: "ended", source: "unknown" });
    assert.equal((await store.budget.status("case-1")).reservedMicrousd, 180_000);
    await store.budget.settle(context, 4_000, { execution: "ended", source: "upstream_usage" });
    await store.budget.settle(context, 4_000, { execution: "ended", source: "upstream_usage" });
    assert.equal((await store.budget.status("case-1")).reservedMicrousd, 4_000);
    assert.equal((await store.budget.status("case-1")).charges?.[0]?.source, "upstream_usage");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("the Mock budget enforces the same two-execution gate as the durable C adapter", async () => {
  const clock = new ManualClock();
  const mock = createMockTroubleshooting({ clock });
  await mock.ports.budget.reserve(call("one", "one"), 180_000);
  await mock.ports.budget.reserve(call("two", "two"), 180_000);
  let admitted = false;
  const third = mock.ports.budget.reserve(call("three", "three"), 180_000).then((value) => { admitted = value; return value; });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(admitted, false);
    await mock.ports.budget.settle(call("one", "one"), null, { execution: "ended", source: "unknown" });
    assert.equal(await third, true);
  } finally { clock.advance(180_000); }
});

test("C does not oversell the last POC dollar and restart never resets the 100-dollar ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-budget-global-"));
  const clock = new ManualClock();
  const controls = createMockTroubleshooting({ clock }).ports;
  let store = new SqliteRecords(directory, controls);
  const next = (id: string) => ({ ...call(id, id), deadline: clock.now() + 180_000 });
  try {
    for (let index = 0; index < 49; index++) {
      const context = next(`seed-${index}`);
      assert.equal(await store.budget.reserve(context, 2_000_000), true);
      await store.budget.settle(context, 2_000_000);
      clock.advance(60_000);
    }
    assert.equal(await store.budget.reserve(next("ninety-nine"), 1_000_000), true);
    await store.budget.settle(next("ninety-nine"), 1_000_000);
    assert.deepEqual(await Promise.all([store.budget.reserve(next("winner"), 1_000_000), store.budget.reserve(next("loser"), 1_000_000)]), [true, false]);
    assert.equal((await store.budget.status("winner")).pocMicrousd, 100_000_000);
    store.close();
    store = new SqliteRecords(directory, controls);
    assert.equal((await store.budget.status("winner")).pocMicrousd, 100_000_000);
    assert.equal(await store.budget.reserve(next("after-restart"), 1), false);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("restart preserves unknown execution slots and rolling starts until original-call reconciliation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-budget-restart-"));
  const clock = new ManualClock();
  const controls = createMockTroubleshooting({ clock }).ports;
  let store = new SqliteRecords(directory, controls);
  try {
    const first = call("one", "one");
    await store.budget.reserve(first, 180_000);
    await store.budget.reserve(call("two", "two"), 180_000);
    store.close();
    store = new SqliteRecords(directory, controls);
    const status = await store.budget.status("one");
    assert.equal(status.unsettledCalls, 2);
    assert.equal(status.startsLast60s, 2);
    let admitted = false;
    const waiting = store.budget.reserve(call("three", "three"), 180_000).then((value) => { admitted = value; return value; });
    clock.advance(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(admitted, false);
    await store.budget.settle(first, null, { execution: "ended", source: "unknown" });
    assert.equal(await waiting, true);
    assert.equal((await store.budget.status("one")).reservedMicrousd, 180_000);
    assert.equal((await store.budget.status("three")).pocMicrousd, 540_000);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a failed reserve commit leaves no partial fee, attempt or execution occupancy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-budget-rollback-"));
  let fail = true;
  const store = new SqliteRecords(directory, createMockTroubleshooting().ports, { fault: (point) => {
    if (point === "budget:reserve:before_commit" && fail) { fail = false; throw new Error("synthetic disk fault"); }
  } });
  try {
    await assert.rejects(store.budget.reserve(call("case-1", "call-1"), 180_000), { message: "unavailable" });
    const status = await store.budget.status("case-1");
    assert.equal(status.pocMicrousd, 0);
    assert.equal(status.attempts, 0);
    assert.equal(status.unsettledCalls, 0);
    assert.equal(await store.budget.reserve(call("case-1", "call-1"), 180_000), true);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("B receives the complete canonical synthetic input and conservative frozen-price planning rather than only the report draft", async () => {
  let envelope: ModelEnvelope | undefined;
  const mock = createMockTroubleshooting({ model: async (_context, draft, request) => {
    envelope = request;
    return { candidate: draft, actualMicrousd: null };
  } });
  await mock.receive();
  await mock.closed;
  assert.ok(envelope);
  const body = JSON.parse(envelope.canonicalInput) as { turn: { messages: { role: string; toolsAdded?: unknown[]; content: unknown }[] }; generation: unknown };
  assert.ok(String(body.turn.messages[0]!.content).length > 0);
  assert.equal(body.turn.messages.filter((message) => message.role === "toolResult").length, 2);
  assert.equal(body.turn.messages[0]!.toolsAdded?.length, 2);
  assert.ok(JSON.parse(String(body.turn.messages.at(-1)!.content)).draft);
  assert.deepEqual(body.generation, { maxOutputTokens: 4_000, includesReasoning: true });
  assert.ok(envelope.inputTokensUpperBound <= 24_000);
  assert.equal(envelope.hiddenRetries, 0);
  assert.deepEqual(envelope.planning, { snapshotRef: "public-pricing-2026-10-20", inputCategory: "long-write-upper-bound",
    inputMicrousdPerMillion: 5_000_000, outputMicrousdPerMillion: 15_000_000, reservationMicrousd: 180_000 });
  assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 180_000);
});

test("the full 24k input limit rejects oversized canonical content before reserving or generating", async () => {
  const mock = createMockTroubleshooting();
  await mock.receive({ input: { applicationId: "SYNTHETIC-SECRET-APPLICATION", question: "x".repeat(50_000) } });
  await mock.closed;
  assert.equal(mock.events.some((event) => event.action === "model.generate"), false);
  assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 0);
  const view = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in view && view.stopReason === "budget_exhausted");
});

test("B refuses missing, extra or unproven canonical protocol content before its synthetic provider is invoked", async () => {
  for (const fault of ["missing", "extra", "unproven", "false-bound", "missing-envelope"]) {
    let providerCalls = 0;
    const mock = createMockTroubleshooting({ model: async (_context, draft) => { providerCalls++; return { candidate: draft, actualMicrousd: null }; } });
    const generate = mock.ports.model.generate;
    mock.ports.model.generate = (context, turn, beforeSend) => generate(context, turn, async (envelope) => {
      if (fault === "missing-envelope") return beforeSend(undefined!);
      const changed = structuredClone(envelope!);
      const body = JSON.parse(changed.canonicalInput) as Record<string, unknown>;
      if (fault === "missing") delete body.turn;
      if (fault === "extra") body.unmeteredPrompt = "extra";
      if (fault === "unproven") body.protocol = "unknown-provider-protocol";
      const canonicalInput = JSON.stringify(body);
      return beforeSend({ ...changed, canonicalInput,
        inputTokensUpperBound: Math.ceil(Buffer.byteLength(canonicalInput) / 2) + (fault === "false-bound" ? 1 : 0) });
    });
    await mock.receive();
    await mock.closed;
    assert.equal(providerCalls, 0, fault);
    assert.equal(mock.events.some((event) => event.action === "delivery.send"), false, fault);
  }
});

test("only host-verified synthetic protocol, transformation and reasoning limits permit a model attempt", async () => {
  const verified = { protocol: "mock-json-byte-pairs-1", tokenizer: "utf8-byte-pairs-1", transformation: "identity", reasoning: "included",
    hiddenAttempts: 0, inputLimit: 24_000, outputLimit: 4_000 };
  for (const policy of [null, { ...verified, protocol: "gpt-or-cpa-unverified" }, { ...verified, transformation: "unknown" },
    { ...verified, reasoning: "unknown" }, { ...verified, hiddenAttempts: 1 }]) {
    const mock = createMockTroubleshooting({ modelPolicy: policy });
    await mock.receive();
    await mock.closed;
    assert.equal(mock.events.some((event) => event.action === "model.generate"), false);
    assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 0);
  }
});

test("the 4k generation bound includes reasoning and refuses oversized output without treating missing usage as free", async () => {
  const mock = createMockTroubleshooting({ model: async (_context, draft) => ({ candidate: draft, reasoning: "x".repeat(8_000), actualMicrousd: null }) });
  await mock.receive();
  await mock.closed;
  assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
  const status = await mock.ports.budget.status("case-1");
  assert.equal(status.reservedMicrousd, 180_000);
  assert.equal(status.unsettledCalls, 0);
  const view = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in view && view.stopReason === "budget_exhausted");
});

test("one transient network retry has its own reservation and attempt linked to the original operation", async () => {
  const calls: CallContext[] = [];
  const mock = createMockTroubleshooting({ model: async (context, draft) => {
    calls.push(context);
    if (calls.length === 1) throw new ModelFailure("transient_network");
    return { candidate: draft, actualMicrousd: 1_000 };
  } });
  await mock.receive();
  await mock.closed;
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]!.callId, calls[1]!.callId);
  assert.equal(calls[0]!.deadline, calls[1]!.deadline);
  const status = await mock.ports.budget.status("case-1");
  assert.equal(status.attempts, 2);
  assert.equal(status.reservedMicrousd, 181_000);
  assert.equal(status.unsettledCalls, 1);
  const saved = await mock.ports.records.read(mock.inbound, "case-1");
  const attempts = saved!.audits.filter((audit) => audit.action === "model.generate" && audit.stage === "intent");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.operationId, attempts[1]!.operationId);
});

test("a reported actual charge above the proven reservation is retained truthfully and blocks later model admission across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-budget-debt-"));
  let store: SqliteRecords | undefined;
  let providerCalls = 0;
  const boot = () => createMockTroubleshooting({ model: async (_context, draft) => { providerCalls++; return { candidate: draft, actualMicrousd: 250_000 }; },
    controlPorts: (ports) => {
      store = new SqliteRecords(directory, ports);
      return { admission: store.admission, records: store.records, budget: store.budget, audit: store.audit };
    } });
  try {
    const first = boot();
    await first.receive();
    await first.closed;
    assert.equal(first.events.some((event) => event.action === "delivery.send"), false);
    assert.equal((await first.ports.budget.status("case-1")).reservedMicrousd, 250_000);
    const view = await first.application.get(first.inbound, "case-1");
    assert.ok("state" in view && view.stopReason === "contract_unverified");
    store!.close();
    const restarted = boot();
    await restarted.receive({ eventRef: "new-event" });
    await restarted.closed;
    assert.equal(providerCalls, 1);
    assert.equal((await restarted.ports.budget.status("case-1")).pocMicrousd, 250_000);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("schema-1 migration is atomic and retains charges, unknown slots and unprovable legacy bindings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-budget-migrate-"));
  const clock = new ManualClock();
  const mock = createMockTroubleshooting({ clock });
  let store: SqliteRecords | undefined;
  try {
    legacyRecords(directory, call("case-1", "unused"));
    assert.throws(() => { store = new SqliteRecords(directory, mock.ports, { fault: (point) => {
      if (point === "budget:migrate:before_commit") throw new Error("synthetic migration disk failure");
    } }); }, { message: "unavailable" });
    store = new SqliteRecords(directory, mock.ports);
    const status = await store.budget.status("case-1");
    assert.equal(status.reservedMicrousd, 184_000);
    assert.equal(status.pocMicrousd, 364_000);
    assert.equal(status.attempts, 2);
    assert.equal(status.unsettledCalls, 2);
    assert.equal(status.startsLast60s, 3);
    assert.equal(await store.budget.reserve(call("orphan", "orphan:phase-1:unknown"), 180_000), false);
    await assert.rejects(store.budget.settle(call("orphan", "orphan:phase-1:unknown"), 4_000));
    await store.budget.settle(call("case-1", "case-1:phase-1:known"), 4_000);
    await store.budget.settle(call("case-1", "case-1:phase-1:unknown"), null, { execution: "ended", source: "unknown" });
    assert.equal(await store.budget.reserve({ ...call("case-1", "new-phase"), phaseId: 2 }, 180_000), true);
    assert.equal((await store.budget.status("case-1")).pocMicrousd, 544_000);
    assert.equal(mock.events.length, 0);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("parallel C contenders cannot oversell the six-attempt allowance while execution slots turn over", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-budget-parallel-"));
  const store = new SqliteRecords(directory, createMockTroubleshooting().ports);
  try {
    const permitted = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
      const context = call("case-1", `parallel-${index}`);
      const accepted = await store.budget.reserve(context, 180_000);
      if (accepted) await store.budget.settle(context, 1_000);
      return accepted;
    }));
    assert.equal(permitted.filter(Boolean).length, 6);
    const status = await store.budget.status("case-1");
    assert.equal(status.attempts, 6);
    assert.equal(status.reservedMicrousd, 6_000);
    assert.equal(status.unsettledCalls, 0);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C queue admission coalesces exact calls, rejects overflow and expires without creating charge rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-budget-queue-"));
  const clock = new ManualClock();
  const store = new SqliteRecords(directory, createMockTroubleshooting({ clock }).ports);
  try {
    await store.budget.reserve(call("one", "one"), 180_000);
    await store.budget.reserve(call("two", "two"), 180_000);
    const pending = Array.from({ length: 32 }, (_, index) => store.budget.reserve(call(`queued-${index}`, `queued-${index}`), 180_000));
    const duplicate = store.budget.reserve(call("queued-0", "queued-0"), 180_000);
    await assert.rejects(store.budget.reserve(call("overflow", "overflow"), 180_000), { message: "unavailable" });
    clock.advance(180_000);
    assert.equal((await Promise.all(pending)).some(Boolean), false);
    assert.equal(await duplicate, false);
    const status = await store.budget.status("queued-0");
    assert.equal(status.attempts, 0);
    assert.equal(status.pocMicrousd, 360_000);
    assert.equal(status.unsettledCalls, 2);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C bounds stalled start controls after local timeout and never admits their late authorization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-budget-start-control-"));
  const clock = new ManualClock();
  const store = new SqliteRecords(directory, createMockTroubleshooting({ clock }).ports);
  const release = Promise.withResolvers<void>();
  let controls = 0;
  const beforeStart = async () => { controls++; await release.promise; };
  try {
    const pending = Array.from({ length: 32 }, (_, index) => store.budget.reserve(call(`stalled-${index}`, `stalled-${index}`), 180_000, beforeStart));
    const duplicate = store.budget.reserve(call("stalled-0", "stalled-0"), 180_000, beforeStart);
    await assert.rejects(store.budget.reserve(call("overflow", "overflow"), 180_000, beforeStart), { message: "unavailable" });
    assert.equal(controls, 32);
    clock.advance(180_000);
    assert.equal((await Promise.all(pending)).some(Boolean), false);
    assert.equal(await duplicate, false);
    const fresh = { ...call("fresh", "fresh"), deadline: 360_000 };
    await assert.rejects(store.budget.reserve(fresh, 180_000, beforeStart), { message: "unavailable" });
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await store.budget.status("stalled-0")).pocMicrousd, 0);
    assert.equal(await store.budget.reserve(fresh, 180_000, beforeStart), true);
    assert.equal(controls, 33);
  } finally { release.resolve(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("UTC jumps cannot expire a rolling model window in Mock or durable C, including restart", async () => {
  for (const durable of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "bau-budget-monotonic-"));
    let elapsed = new ManualClock();
    let wallShift = 0;
    const clock = { now: () => elapsed.now(), schedule: (deadline: number, callback: () => void) => elapsed.schedule(deadline, callback),
      utc: () => new Date(Date.parse(elapsed.utc()) + wallShift).toISOString() };
    const mock = createMockTroubleshooting({ clock });
    let store = durable ? new SqliteRecords(directory, mock.ports) : undefined;
    let budget = store?.budget ?? mock.ports.budget;
    try {
      for (let index = 0; index < 6; index++) {
        const context = call(`case-${index}`, `call-${index}`);
        assert.equal(await budget.reserve(context, 180_000), true);
        await budget.settle(context, 1_000);
      }
      wallShift += 3_600_000;
      if (store) {
        store.close();
        elapsed = new ManualClock();
        store = new SqliteRecords(directory, mock.ports);
        budget = store.budget;
      }
      let started = false;
      const queued = budget.reserve(call("seventh", "seventh"), 180_000).then((value) => { started = value; return value; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(started, false, durable ? "durable restart" : "Mock");
      assert.equal((await budget.status("seventh")).startsLast60s, 6);
      elapsed.advance(59_999);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(started, false);
      elapsed.advance(1);
      assert.equal(await queued, true);
    } finally { elapsed.advance(180_000); store?.close(); await rm(directory, { recursive: true, force: true }); }
  }
});


test("C refuses a missing persisted rate clock instead of resetting the rolling ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-budget-clock-loss-"));
  const controls = createMockTroubleshooting().ports;
  let store: SqliteRecords | undefined;
  try {
    store = new SqliteRecords(directory, controls);
    await store.budget.reserve(call("original", "original"), 180_000);
    store.close();
    store = undefined;
    // Fault setup only: remove a required row in this test's closed synthetic database.
    const fixture = new DatabaseSync(join(directory, "records.sqlite"));
    fixture.exec("DELETE FROM budget_clock");
    fixture.close();
    assert.throws(() => { store = new SqliteRecords(directory, controls); }, { message: "unavailable" });
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});
