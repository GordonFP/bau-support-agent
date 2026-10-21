import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { ManualClock } from "../fixtures/clock.js";
import { ModelFailure } from "../../src/troubleshooting/application/model-failure.js";
import type { ModelEnvelope } from "../../src/troubleshooting/application/model-contract.js";

test("cancellation retains unknown global slots and fees, so a queued third case cannot start", async () => {
  const clock = new ManualClock();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let calls = 0;
  const mock = createMockTroubleshooting({ clock, model: async (_context, draft) => {
    calls++;
    (calls === 1 ? first : second).resolve();
    await finish.promise;
    return { candidate: draft, actualMicrousd: null };
  } });
  try {
    await mock.receive();
    await first.promise;
    await mock.receive({ eventRef: "second" });
    await second.promise;
    await mock.receive({ eventRef: "third" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    await mock.application.cancel(mock.inbound, "case-1");
    await new Promise((resolve) => setImmediate(resolve));
    const status = await mock.ports.budget.status("case-1");
    assert.equal(status.reservedMicrousd, 180_000);
    assert.equal(status.unsettledCalls, 2);
    assert.equal(status.charges?.[0]?.source, "unknown");
    assert.equal(calls, 2);
  } finally {
    await mock.application.cancel(mock.inbound, "case-2");
    await mock.application.cancel(mock.inbound, "case-3");
    finish.resolve();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal((await mock.ports.budget.status("case-1")).pocMicrousd, 360_000);
});

test("six complete synthetic attempts retain the independent 1.08-dollar plan and include previous replies in full input", async () => {
  const envelopes: ModelEnvelope[] = [];
  const mock = createMockTroubleshooting({ agent: async (_context, request) => {
    await request.invoke("logs.read", null);
    await request.invoke("code.search", null);
    let candidate: unknown;
    for (let attempt = 0; attempt < 6; attempt++) candidate = await request.generate(request.diagnose());
    return candidate;
  }, model: async (_context, draft, envelope) => { envelopes.push(envelope!); return { candidate: draft, actualMicrousd: null }; } });
  await mock.receive();
  await mock.closed;
  assert.equal(envelopes.length, 6);
  assert.equal(envelopes[0]!.planning.reservationMicrousd, 180_000);
  assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 1_080_000);
  assert.equal((await mock.ports.budget.status("case-1")).unsettledCalls, 0);
  const messages = (index: number) => (JSON.parse(envelopes[index]!.canonicalInput) as { turn: { messages: { role: string; content: unknown }[] } }).turn.messages;
  assert.equal(messages(0).filter((message) => message.role === "assistant").length, 2);
  assert.equal(messages(5).filter((message) => message.role === "assistant").length, 7);
});

test("two transient network failures exhaust the only retry while non-network refusals are never retried", async () => {
  for (const kind of ["transient_network", "denied", "contract_unverified", "schema_mismatch", "invalid_request"] as const) {
    let calls = 0;
    const mock = createMockTroubleshooting({ model: async () => { calls++; throw new ModelFailure(kind); } });
    await mock.receive();
    await mock.closed;
    assert.equal(calls, kind === "transient_network" ? 2 : 1, kind);
    const status = await mock.ports.budget.status("case-1");
    assert.equal(status.reservedMicrousd, kind === "transient_network" ? 360_000 : 180_000, kind);
    assert.equal(status.unsettledCalls, calls, kind);
    assert.equal(mock.events.some((event) => event.action === "delivery.send"), false, kind);
  }
});

test("a retry still ends at the first attempt's 60-second deadline", async () => {
  const clock = new ManualClock();
  const first = Promise.withResolvers<void>();
  const fail = Promise.withResolvers<void>();
  const retried = Promise.withResolvers<number>();
  const finish = Promise.withResolvers<void>();
  let calls = 0;
  const mock = createMockTroubleshooting({ clock, model: async (context, draft) => {
    calls++;
    if (calls === 1) { first.resolve(); await fail.promise; throw new ModelFailure("transient_network"); }
    retried.resolve(context.deadline);
    await finish.promise;
    return { candidate: draft, actualMicrousd: null };
  } });
  try {
    await mock.receive();
    await first.promise;
    clock.advance(59_000);
    fail.resolve();
    assert.equal(await retried.promise, 60_000);
    clock.advance(999);
    const active = await mock.application.get(mock.inbound, "case-1");
    assert.ok("state" in active && active.state === "investigating");
    clock.advance(1);
    await mock.closed;
    const stopped = await mock.application.get(mock.inbound, "case-1");
    assert.ok("state" in stopped && stopped.stopReason === "timeout");
    assert.equal(calls, 2);
    assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 360_000);
  } finally { fail.resolve(); finish.resolve(); }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
});

test("a sixth-attempt network failure cannot obtain an extra retry beyond the case allowance", async () => {
  let calls = 0;
  const mock = createMockTroubleshooting({ agent: async (_context, request) => {
    let candidate: unknown;
    for (let attempt = 0; attempt < 6; attempt++) candidate = await request.generate(request.diagnose());
    return candidate;
  }, model: async (_context, draft) => {
    if (++calls === 6) throw new ModelFailure("transient_network");
    return { candidate: draft, actualMicrousd: 1_000 };
  } });
  await mock.receive();
  await mock.closed;
  assert.equal(calls, 6);
  assert.equal((await mock.ports.budget.status("case-1")).attempts, 6);
  assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 185_000);
  const view = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in view && view.stopReason === "budget_exhausted");
});

test("the complete Mock input accepts exactly 24k byte-pair tokens and rejects one more token", async () => {
  let observed: ModelEnvelope | undefined;
  const probe = createMockTroubleshooting({ model: async (_context, draft, envelope) => { observed = envelope; return { candidate: draft, actualMicrousd: null }; } });
  await probe.receive();
  await probe.closed;
  const padding = (47_999 - Buffer.byteLength(observed!.canonicalInput)) / 2;
  assert.ok(Number.isSafeInteger(padding) && padding > 0);
  for (const excess of [0, 1]) {
    let received: ModelEnvelope | undefined;
    const mock = createMockTroubleshooting({ model: async (_context, _draft, envelope) => { received = envelope; return { candidate: {}, actualMicrousd: null }; } });
    await mock.receive({ input: { ...mock.inbound.input, question: mock.inbound.input.question + "x".repeat(padding + excess) } });
    await mock.closed;
    if (excess === 0) {
      assert.equal(received?.inputTokensUpperBound, 24_000);
      assert.equal(Buffer.byteLength(received!.canonicalInput), 47_999);
    } else {
      assert.equal(received, undefined);
      assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 0);
    }
  }
});

test("exactly 4k generated Mock tokens including reasoning are accepted and the next byte is refused", async () => {
  for (const excess of [0, 1]) {
    const mock = createMockTroubleshooting({ model: async (_context, draft) => {
      const framing = Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(draft) }], reasoning: "" }));
      return { candidate: draft, actualMicrousd: null, reasoning: "x".repeat(8_000 - framing + excess) };
    } });
    await mock.receive();
    await mock.closed;
    const view = await mock.application.get(mock.inbound, "case-1");
    assert.ok("state" in view);
    assert.equal(view.state, excess === 0 ? "completed" : "stopped");
    assert.equal(mock.events.some((event) => event.action === "delivery.send"), excess === 0);
    assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 180_000);
  }
});

test("time in the model queue consumes the original host deadline without creating an unstarted reservation", async () => {
  const clock = new ManualClock();
  const twoStarted = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let calls = 0;
  const mock = createMockTroubleshooting({ clock, model: async (_context, draft) => {
    if (++calls === 2) twoStarted.resolve();
    await finish.promise;
    return { candidate: draft, actualMicrousd: null };
  } });
  try {
    await mock.receive();
    await mock.receive({ eventRef: "second" });
    await twoStarted.promise;
    await mock.receive({ eventRef: "queued" });
    await new Promise((resolve) => setImmediate(resolve));
    clock.advance(60_000);
    await mock.phaseClosed(1, "case-3");
    const view = await mock.application.get(mock.inbound, "case-3");
    assert.ok("state" in view && view.state === "stopped" && view.stopReason === "timeout");
    assert.equal(calls, 2);
    assert.equal((await mock.ports.budget.status("case-3")).attempts, 0);
    assert.equal((await mock.ports.budget.status("case-3")).pocMicrousd, 360_000);
  } finally { finish.resolve(); }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
});

test("model authorization revoked while queued is checked again before the actual start", async () => {
  const denyActions: string[] = [];
  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const firstFinish = Promise.withResolvers<void>();
  const secondFinish = Promise.withResolvers<void>();
  let calls = 0;
  const mock = createMockTroubleshooting({ denyActions, model: async (_context, draft) => {
    if (++calls === 1) { firstStarted.resolve(); await firstFinish.promise; }
    else if (calls === 2) { secondStarted.resolve(); await secondFinish.promise; }
    return { candidate: draft, actualMicrousd: 1_000 };
  } });
  try {
    await mock.receive();
    await firstStarted.promise;
    await mock.receive({ eventRef: "second" });
    await secondStarted.promise;
    await mock.receive({ eventRef: "queued" });
    await new Promise((resolve) => setImmediate(resolve));
    denyActions.push("model.generate");
    firstFinish.resolve();
    await mock.phaseClosed(1, "case-3");
    assert.equal(calls, 2);
    const view = await mock.application.get(mock.inbound, "case-3");
    assert.ok("state" in view && view.stopReason === "denied");
    assert.equal((await mock.ports.budget.status("case-3")).attempts, 0);
  } finally { firstFinish.resolve(); secondFinish.resolve(); }
});

test("authorization revoked during model-input persistence is checked before the first start", async () => {
  const denyActions: string[] = [];
  const savingInput = Promise.withResolvers<void>();
  const finishSaving = Promise.withResolvers<void>();
  let calls = 0;
  const mock = createMockTroubleshooting({ denyActions, controlPorts: (ports) => { const records = ports.records; return { records: {
    ...records,
    append: async (context, record) => {
      if (record.kind === "model_input") { savingInput.resolve(); await finishSaving.promise; }
      await records.append(context, record);
    },
  } }; }, model: async (_context, draft) => { calls++; return { candidate: draft, actualMicrousd: 1_000 }; } });
  try {
    await mock.receive();
    await savingInput.promise;
    denyActions.push("model.generate");
    finishSaving.resolve();
    await mock.closed;
    const view = await mock.application.get(mock.inbound, "case-1");
    assert.ok("state" in view && view.stopReason === "denied");
    assert.equal(calls, 0);
    assert.equal((await mock.ports.budget.status("case-1")).attempts, 0);
    assert.ok((await mock.ports.records.read(mock.inbound, "case-1"))?.audits.some((event) => event.action === "authorization.denied"));
  } finally { finishSaving.resolve(); }
});

for (const part of ["text", "toolCall"] as const) test(`B rejects oversized actual assistant ${part} before storing or sending`, async () => {
  const mock = createMockTroubleshooting({ model: async () => ({ candidate: "ok", actualMicrousd: 1_000, reasoning: part === "toolCall" ? "r".repeat(4_000) : "",
    message: { stopReason: part === "text" ? "stop" : "toolUse", content: part === "text" ? [{ type: "text", text: "x".repeat(100_000) }]
      : Array.from({ length: 16 }, (_, index) => ({ type: "toolCall" as const, id: `${index}-${"x".repeat(250)}`, name: "logs_read" as const, arguments: {} })) } }) });
  await mock.receive(); await mock.closed;
  const stored = await mock.ports.records.read(mock.inbound, "case-1");
  assert.ok(stored?.scope === "full");
  assert.equal(stored.view.stopReason, "budget_exhausted");
  assert.equal(stored.records.some((record) => record.kind === "model_output"), false);
  assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
});
