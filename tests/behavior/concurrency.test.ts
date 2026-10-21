import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { MockPrivateConversation } from "../../src/adapters/mock/communication.js";
import { ManualClock } from "../fixtures/clock.js";

for (const action of ["model.generate", "logs.read"] as const) {
  test(`${action} is clipped to remaining phase time and ongoing progress cannot extend it`, { timeout: 5_000 }, async () => {
    const clock = new ManualClock();
    const finish = Promise.withResolvers<void>();
    const started = Promise.withResolvers<number>();
    let progress: (value: unknown) => void = () => {};
    const mock = createMockTroubleshooting({ clock, agent: async (_context, request) => {
      progress = request.progress;
      clock.advance(170_000);
      if (action === "logs.read") return request.invoke("logs.read", null);
      return request.generate(request.diagnose());
    }, model: async (context, draft) => { started.resolve(context.deadline); await finish.promise; return { candidate: draft, actualMicrousd: null }; } });
    if (action === "logs.read") {
      const read = mock.ports.logs.read;
      mock.ports.logs.read = async (context, query) => { started.resolve(context.deadline); await finish.promise; return read(context, query); };
    }
    await mock.receive();
    assert.equal(await started.promise, 180_000);
    for (let second = 0; second < 9; second++) { clock.advance(1_000); progress({ status: "working" }); }
    const active = await mock.application.get(actor, "case-1");
    assert.ok("state" in active);
    assert.equal(active.state, "investigating");
    clock.advance(1_000);
    await mock.closed;
    const stopped = await mock.application.get(actor, "case-1");
    assert.ok("state" in stopped);
    assert.equal(stopped.stopReason, "timeout");
    assert.equal(stopped.elapsedMs, 180_000);
    assert.throws(() => progress({ status: "late" }), /cancelled/);
    finish.resolve();
    await new Promise(setImmediate);
    if (action === "model.generate") assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 180_000);
    assert.equal(mock.events.filter((event) => event.action === "delivery.send").length, 0);
  });
}

test("an Agent cannot catch a timed-out model call and start another investigation", { timeout: 5_000 }, async () => {
  const clock = new ManualClock();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting({ clock, model: async (_context, draft) => {
    started.resolve(); await finish.promise; return { candidate: draft, actualMicrousd: null };
  }, agent: async (_context, request) => {
    try { await request.generate(request.diagnose()); } catch { /* a runtime may catch its tool promise */ }
    return request.invoke("logs.read", null);
  } });
  await mock.receive();
  await started.promise;
  clock.advance(60_000);
  await mock.closed;
  const stopped = await mock.application.get(actor, "case-1");
  assert.ok("state" in stopped);
  assert.equal(stopped.stopReason, "timeout");
  assert.equal(mock.events.filter((event) => event.action === "logs.read").length, 0);
  finish.resolve();
});

for (const tool of ["logs.read", "code.search"] as const) {
  test(`${tool} ends local waiting at 30 seconds and discards its late source result`, { timeout: 5_000 }, async () => {
    const clock = new ManualClock();
    const finish = Promise.withResolvers<void>();
    const started = Promise.withResolvers<{ deadline: number }>();
    const mock = createMockTroubleshooting({ clock, agent: async (_context, request) => {
      await request.invoke(tool, null);
      return request.generate(request.diagnose());
    } });
    if (tool === "logs.read") {
      const read = mock.ports.logs.read;
      mock.ports.logs.read = async (context, query) => { started.resolve(context); await finish.promise; return read(context, query); };
    } else {
      const search = mock.ports.code.search;
      mock.ports.code.search = async (context, query) => { started.resolve(context); await finish.promise; return search(context, query); };
    }
    await mock.receive();
    assert.equal((await started.promise).deadline, 30_000);
    clock.advance(29_000);
    const before = await mock.application.get(actor, "case-1");
    assert.ok("state" in before);
    assert.equal(before.state, "investigating");
    clock.advance(1_000);
    await mock.closed;
    const stopped = await mock.application.get(actor, "case-1");
    assert.ok("state" in stopped);
    assert.equal(stopped.stopReason, "timeout");
    assert.equal(mock.events.filter((event) => event.action === "agent.abort").length, 1);
    finish.resolve();
    await new Promise(setImmediate);
    assert.equal(mock.events.filter((event) => event.action === "model.generate").length, 0);
    assert.deepEqual(await mock.application.get(actor, "case-1"), stopped);
  });
}

test("cancel finishes local cleanup within five seconds even when runtime abort and close never confirm", { timeout: 5_000 }, async () => {
  const clock = new ManualClock();
  const stuck = Promise.withResolvers<void>();
  const runtime = Promise.withResolvers<unknown>();
  const abortStarted = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting({ clock, agent: async () => runtime.promise });
  mock.ports.agent.abort = async () => { abortStarted.resolve(); await stuck.promise; };
  mock.ports.agent.close = async () => { await stuck.promise; };
  await mock.receive();
  let returned = false;
  const cancelling = mock.application.cancel(actor, "case-1").then((result) => { returned = true; return result; });
  await abortStarted.promise;
  try {
    clock.advance(4_999);
    await new Promise(setImmediate);
    assert.equal(returned, false);
    clock.advance(1);
    await new Promise(setImmediate);
    assert.equal(returned, true);
    const view = await cancelling;
    assert.ok("state" in view);
    assert.equal(view.stopReason, "cancelled");
    assert.equal(view.elapsedMs, 0);
  } finally { stuck.resolve(); runtime.resolve({}); }
  await cancelling;
  assert.equal(mock.events.filter((event) => event.action === "logs.read").length, 0);
});

test("a model stops locally at 60 seconds while its original reservation and late settlement stay linked", { timeout: 5_000 }, async () => {
  const clock = new ManualClock();
  const started = Promise.withResolvers<{ signal: AbortSignal; deadline: number }>();
  const finish = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting({ clock, model: async (context, draft) => {
    started.resolve(context);
    await finish.promise;
    return { candidate: draft, actualMicrousd: 4_000 };
  } });
  await mock.receive();
  const context = await started.promise;
  try {
    assert.equal(context.deadline, 60_000);
    clock.advance(59_000);
    assert.equal(context.signal.aborted, false);
    const active = await mock.application.get(actor, "case-1");
    assert.ok("state" in active);
    assert.equal(active.state, "investigating");
    clock.advance(1_000);
    await new Promise(setImmediate);
    const stopped = await mock.application.get(actor, "case-1");
    assert.ok("state" in stopped);
    assert.equal(stopped.stopReason, "timeout");
    assert.equal(context.signal.aborted, true);
    assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 180_000);
    await mock.closed;
  } finally { finish.resolve(); }
  await new Promise(setImmediate);
  assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 4_000);
  assert.equal(mock.events.filter((event) => event.action === "delivery.send").length, 0);
  assert.ok(mock.events.some((event) => event.action === "audit:model.generate:complete" && (event.input as { outcome: string }).outcome === "discarded"));
});

const actor = { principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1" };
const candidates = [
  { applicationId: "SYNTHETIC-SECRET-APPLICATION", submittedAt: "2026-10-18T10:00:00.000Z" },
  { applicationId: "SYNTHETIC-SECRET-APPLICATION-SECOND", submittedAt: "2026-10-18T15:00:00.000Z" },
];

test("a current source sanitization failure cannot be audited as an accepted result", { timeout: 5_000 }, async () => {
  const mock = createMockTroubleshooting();
  const sanitize = mock.ports.sanitization.sanitize;
  mock.ports.sanitization.sanitize = (value, caseRef) => {
    if (value && typeof value === "object" && "evidence" in value) throw new Error("synthetic-sensitive-error");
    return sanitize(value, caseRef);
  };
  await mock.receive();
  await mock.closed;
  const completions = mock.events.filter((event) => event.action === "audit:logs.read:complete").map((event) => (event.input as { outcome: string }).outcome);
  assert.deepEqual(completions, ["rejected"]);
  assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send"), false);
});

test("unaccepted admission candidates clear only their own transient aliases", { timeout: 5_000 }, async () => {
  for (const failure of ["full", "error"] as const) {
    const mock = createMockTroubleshooting();
    const cleared: string[] = [];
    mock.ports.sanitization.clear = (caseRef) => { cleared.push(caseRef); };
    mock.ports.admission.confirm = async () => {
      if (failure === "error") throw new Error("synthetic-sensitive-error");
      return { status: "full" };
    };
    assert.equal((await mock.receive()).status, "service_unavailable");
    assert.deepEqual(cleared, ["case-1"]);
    assert.equal(mock.events.some((event) => event.action === "logs.read"), false);
  }
  const pending = Promise.withResolvers<unknown>();
  const mock = createMockTroubleshooting({ agent: async () => pending.promise });
  await mock.receive();
  const cleared: string[] = [];
  mock.ports.sanitization.clear = (caseRef) => { cleared.push(caseRef); };
  mock.ports.admission.confirm = async () => ({ status: "duplicate", caseRef: "case-1", principalRef: "principal-1" });
  const duplicate = await mock.receive({ eventRef: "same-platform-event-alias" });
  assert.equal(duplicate.status, "duplicate");
  assert.deepEqual(cleared, ["case-2"]);
  await mock.application.cancel(actor, "case-1");
  pending.resolve({});
});

test("cancellation during delivery retains an unknown send and a repeated event never sends it again", { timeout: 5_000 }, async () => {
  const sending = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting();
  const send = mock.ports.delivery.send;
  mock.ports.delivery.send = async (destination, report, key) => {
    sending.resolve(); await finish.promise; return send(destination, report, key);
  };
  await mock.receive();
  await sending.promise;
  const cancelled = await mock.application.cancel(actor, "case-1");
  assert.ok("state" in cancelled);
  assert.equal(cancelled.deliveryStatus, "unknown");
  finish.resolve();
  await mock.closed;
  await new Promise(setImmediate);
  const duplicate = await mock.receive();
  assert.equal(duplicate.status, "duplicate");
  assert.ok("view" in duplicate);
  assert.equal(duplicate.view.stopReason, "cancelled");
  assert.equal(duplicate.view.deliveryStatus, "unknown");
  assert.equal(mock.events.filter((event) => event.action === "delivery.send").length, 1);
});

test("cancelling A, reconnecting A and its late model cannot alter authorized user B's case", { timeout: 5_000 }, async () => {
  const second = { principalRef: "principal-2", tenantRef: "tenant-1", destinationRef: "private-conversation-2" };
  const aStarted = Promise.withResolvers<void>();
  const bStarted = Promise.withResolvers<void>();
  const finishA = Promise.withResolvers<void>();
  const finishB = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting({ authorizedActors: [actor, second], model: async (context, draft) => {
    if (context.principalRef === actor.principalRef) { aStarted.resolve(); await finishA.promise; }
    else { bStarted.resolve(); await finishB.promise; }
    return { candidate: draft, actualMicrousd: null };
  } });
  const acceptedA = await mock.receive();
  const acceptedB = await mock.receive({ ...second, eventRef: "event-1" });
  assert.equal(acceptedA.status, "accepted");
  assert.equal(acceptedB.status, "accepted");
  assert.ok("view" in acceptedB);
  await Promise.all([aStarted.promise, bStarted.promise]);
  assert.deepEqual(await mock.application.get(actor, acceptedB.view.caseRef), { status: "denied" });
  const beforeB = await mock.application.get(second, acceptedB.view.caseRef);
  await mock.application.cancel(actor, "case-1");
  const reconnect = await mock.receive();
  assert.equal(reconnect.status, "duplicate");
  finishA.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(await mock.application.get(second, acceptedB.view.caseRef), beforeB);
  assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 180_000);
  finishB.resolve();
  await mock.phaseClosed(1, acceptedB.view.caseRef);
  const delivery = await mock.delivery.next();
  assert.equal(delivery.destinationRef, second.destinationRef);
  assert.ok(delivery.report.evidence.every((item) => item.caseRef === acceptedB.view.caseRef));
  assert.equal(mock.events.filter((event) => event.action === "delivery.send").length, 1);
  assert.equal(mock.events.filter((event) => event.action === "agent.abort").length, 1);
});

test("clarification admission is bounded while current authorization stalls and duplicate events coalesce", { timeout: 5_000 }, async () => {
  const mock = createMockTroubleshooting({ customerCandidates: candidates });
  await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  await mock.closed;
  const gate = Promise.withResolvers<void>();
  const allows = mock.ports.authorization.allows;
  let started = 0;
  mock.ports.authorization.allows = async (action, context) => {
    if (action === "provideInformation") { started++; await gate.promise; }
    return allows(action, context);
  };
  const reply = { ...actor, eventRef: "reply-1", receivedAt: "2026-10-19T09:00:01Z",
    reply: { caseRef: "case-1", questionId: "case-1:question:1" }, content: {} };
  const first = mock.application.provideInformation(reply);
  const duplicate = mock.application.provideInformation(reply);
  const more = Array.from({ length: 31 }, (_, index) => mock.application.provideInformation({ ...reply, eventRef: `reply-${index + 2}` }));
  const overflow = await mock.application.provideInformation({ ...reply, eventRef: "reply-overflow" });
  assert.deepEqual(overflow, { status: "denied", reason: "rate_limited" });
  assert.equal(started, 1);
  gate.resolve();
  assert.equal((await first).status, "needs_information");
  assert.equal((await duplicate).status, "duplicate");
  await Promise.all(more);
  await mock.application.cancel(actor, "case-1");
});

test("cancel rechecks current trusted scope, is idempotent and never discloses another case", { timeout: 5_000 }, async () => {
  const pending = Promise.withResolvers<unknown>();
  const mock = createMockTroubleshooting({ agent: async () => pending.promise });
  const accepted = await mock.receive();
  assert.ok("view" in accepted);
  const ref = accepted.view.caseRef;
  const denied = { status: "denied" };
  assert.deepEqual(await mock.application.cancel({ ...actor, principalRef: "other" }, ref), denied);
  assert.deepEqual(await mock.application.cancel(actor, "missing"), denied);
  assert.deepEqual(await mock.application.get({ ...actor, destinationRef: "other-conversation" }, ref), denied);
  let cancelled = await mock.application.cancel(actor, ref);
  assert.ok("state" in cancelled);
  assert.equal(cancelled.state, "stopped");
  assert.equal(cancelled.stopReason, "cancelled");
  assert.deepEqual(await mock.application.cancel(actor, ref), cancelled);
  const allows = mock.ports.authorization.allows;
  mock.ports.authorization.allows = async (action, context) => action !== "cancel" && action !== "get" && allows(action, context);
  assert.deepEqual(await mock.application.cancel(actor, ref), denied);
  assert.deepEqual(await mock.application.get(actor, ref), denied);
  pending.resolve({});
  await mock.closed;
  assert.equal(mock.events.filter((event) => event.action === "delivery.send").length, 0);
});

test("D checks raw UTF-8 bytes before parsing and takes identity only from its trusted host", { timeout: 5_000 }, async () => {
  const hold = Promise.withResolvers<unknown>();
  const mock = createMockTroubleshooting({ agent: async () => hold.promise });
  const intake = new MockPrivateConversation(mock.application, mock.inbound);
  const base = { applicationId: "SYNTHETIC-SECRET-APPLICATION", question: "" };
  const padding = 65_536 - Buffer.byteLength(JSON.stringify(base));
  const exact = Buffer.from(JSON.stringify({ ...base, question: "x".repeat(padding) }));
  assert.equal(exact.byteLength, 65_536);
  const accepted = await intake.receive(exact);
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(await intake.receive(Buffer.concat([exact, Buffer.from(" ")])), { status: "denied", reason: "invalid_request" });
  assert.deepEqual(await intake.receive(Buffer.from(JSON.stringify({ ...base, principalRef: "principal-1" }))), { status: "denied", reason: "invalid_request" });
  assert.equal(mock.events.filter((event) => event.action === "admission.confirm").length, 1);
  hold.reject(new Error("cancelled"));
  await mock.closed;
});

test("A rejects oversized input before authorization and admission", async () => {
  const mock = createMockTroubleshooting();
  const result = await mock.receive({ input: { applicationId: "synthetic", question: "界".repeat(22_000) } });
  assert.deepEqual(result, { status: "denied", reason: "invalid_request" });
  assert.deepEqual(mock.events, []);
});

test("concurrent copies of one trusted platform event share one confirmed case and one investigation", { timeout: 5_000 }, async () => {
  const mock = createMockTroubleshooting();
  const results = await Promise.all([mock.receive(), mock.receive(), mock.receive()]);
  assert.deepEqual(results.map((result) => result.status), ["accepted", "duplicate", "duplicate"]);
  const caseRefs = results.filter((result) => "view" in result).map((result) => result.view.caseRef);
  assert.equal(new Set(caseRefs).size, 1);
  await mock.phaseClosed(1, caseRefs[0]!);
  assert.equal(mock.events.filter((event) => event.action === "logs.read").length, 1);
  assert.equal(mock.events.filter((event) => event.action === "model.generate").length, 1);
  assert.equal(mock.events.filter((event) => event.action === "delivery.send").length, 1);
});

test("pending admissions are bounded before authorization can build a waiting queue", { timeout: 5_000 }, async () => {
  const gate = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting();
  const allows = mock.ports.authorization.allows;
  let started = 0;
  mock.ports.authorization.allows = async (action, context) => {
    if (action === "accept") { started++; await gate.promise; }
    return allows(action, context);
  };
  const requests = Array.from({ length: 33 }, (_, index) => mock.receive({ eventRef: `event-${index}` }));
  try { await new Promise(setImmediate); assert.equal(started, 32); }
  finally { gate.resolve(); }
  const results = await Promise.all(requests);
  assert.equal(results.filter((result) => result.status === "accepted").length, 32);
  assert.deepEqual(results[32], { status: "service_unavailable", reason: "unavailable" });
  for (const result of results) if ("view" in result) {
    await mock.application.cancel(actor, result.view.caseRef);
    await mock.phaseClosed(1, result.view.caseRef);
  }
});

test("31 waiting cases plus one active case fill capacity; a duplicate still returns its current authorized state", { timeout: 5_000 }, async () => {
  const held = Promise.withResolvers<unknown>();
  const denyActions: string[] = [];
  const mock = createMockTroubleshooting({ customerCandidates: candidates, denyActions, agent: async (context, request) => {
    if (context.caseRef === "case-1") return held.promise;
    return request.invoke("logs.read", null);
  } });
  const first = await mock.receive();
  assert.ok("view" in first);
  for (let index = 1; index < 32; index++) {
    const waiting = await mock.receive({ eventRef: `waiting-${index}`, input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
    assert.equal(waiting.status, "accepted");
    assert.ok("view" in waiting);
    await mock.phaseClosed(1, waiting.view.caseRef);
    const view = await mock.application.get(actor, waiting.view.caseRef);
    assert.ok("state" in view);
    assert.equal(view.state, "awaiting_input");
  }
  assert.deepEqual(await mock.receive({ eventRef: "overflow" }), { status: "service_unavailable", reason: "unavailable" });
  const duplicate = await mock.receive();
  assert.equal(duplicate.status, "duplicate");
  assert.ok("view" in duplicate);
  assert.equal(duplicate.view.caseRef, first.view.caseRef);
  denyActions.push("accept");
  assert.deepEqual(await mock.receive(), { status: "denied", reason: "denied" });
  denyActions.pop();
  await mock.application.cancel(actor, first.view.caseRef);
  held.resolve({});
  const afterRelease = await mock.receive({ eventRef: "replacement", input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  assert.equal(afterRelease.status, "accepted");
  assert.ok("view" in afterRelease);
  await mock.phaseClosed(1, afterRelease.view.caseRef);
  for (let index = 2; index <= 33; index++) await mock.application.cancel(actor, `case-${index}`);
});

test("acceptance waits for the digest Port's confirmation and exposes no raw platform key", { timeout: 5_000 }, async () => {
  const mock = createMockTroubleshooting();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const confirm = mock.ports.admission.confirm;
  mock.ports.admission.confirm = async (record) => { entered.resolve(); await gate.promise; return confirm(record); };
  let answered = false;
  const accepting = mock.receive().then((result) => { answered = true; return result; });
  await entered.promise;
  assert.equal(answered, false);
  assert.equal(mock.events.some((event) => event.action === "logs.read"), false);
  assert.equal(mock.events.some((event) => event.action === "audit:accept:complete"), false);
  gate.resolve();
  assert.equal((await accepting).status, "accepted");
  await mock.closed;
  const confirmation = mock.events.find((event) => event.action === "admission.confirm")!.input as { key: string };
  assert.match(confirmation.key, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(confirmation), /event-1|tenant-1|private-conversation-1/);
});

test("a confirmed admission whose accepted audit fails remains stopped and cannot be investigated on retry", { timeout: 5_000 }, async () => {
  const mock = createMockTroubleshooting({ auditFails: "accept:complete" });
  assert.deepEqual(await mock.receive(), { status: "service_unavailable", reason: "audit_unavailable" });
  const duplicate = await mock.receive();
  assert.equal(duplicate.status, "duplicate");
  assert.ok("view" in duplicate);
  assert.equal(duplicate.view.stopReason, "audit_unavailable");
  assert.equal(mock.events.filter((event) => event.action === "logs.read").length, 0);
});

test("time spent awaiting tool authorization is part of its 30 seconds and cannot start a late read", { timeout: 5_000 }, async () => {
  const clock = new ManualClock();
  const queued = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting({ clock });
  const allows = mock.ports.authorization.allows;
  mock.ports.authorization.allows = async (action, context) => {
    if (action === "logs.read") { queued.resolve(); await release.promise; }
    return allows(action, context);
  };
  await mock.receive();
  await queued.promise;
  clock.advance(30_000);
  await mock.closed;
  release.resolve();
  await new Promise(setImmediate);
  const view = await mock.application.get(actor, "case-1");
  assert.ok("state" in view);
  assert.equal(view.stopReason, "timeout");
  assert.equal(mock.events.filter((event) => event.action === "logs.read" || event.action === "model.generate").length, 0);
});

for (const control of ["authorization", "confirmation", "accepted-audit"] as const) {
  test(`pre-ack ${control} waiting ends at 180 seconds and late completion never starts investigation`, { timeout: 5_000 }, async () => {
    const clock = new ManualClock();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const mock = createMockTroubleshooting({ clock });
    if (control === "authorization") {
      const allows = mock.ports.authorization.allows;
      mock.ports.authorization.allows = async (action, context) => {
        if (action === "accept") { entered.resolve(); await release.promise; }
        return allows(action, context);
      };
    } else if (control === "confirmation") {
      const confirm = mock.ports.admission.confirm;
      mock.ports.admission.confirm = async (record) => { entered.resolve(); await release.promise; return confirm(record); };
    } else {
      const complete = mock.ports.audit.complete;
      mock.ports.audit.complete = async (context, action, outcome) => {
        if (action === "accept") { entered.resolve(); await release.promise; throw new Error("synthetic-late-audit-failure"); }
        return complete(context, action, outcome);
      };
    }
    let answered = false;
    const accepting = mock.receive().then((result) => { answered = true; return result; });
    await entered.promise;
    try {
      clock.advance(179_000);
      await new Promise(setImmediate);
      assert.equal(answered, false);
      clock.advance(1_000);
      await new Promise(setImmediate);
      assert.equal(answered, true);
      assert.deepEqual(await accepting, { status: "service_unavailable", reason: "timeout" });
    } finally { release.resolve(); }
    await new Promise(setImmediate);
    assert.equal(mock.events.some((event) => event.action === "logs.read" || event.action === "model.generate"), false);
    if (control !== "authorization") {
      const duplicate = await mock.receive();
      assert.equal(duplicate.status, "duplicate");
      assert.ok("view" in duplicate);
      assert.equal(duplicate.view.stopReason, "timeout");
    }
  });
}

test("expired admission waits return locally while their unconfirmed controls keep the bounded capacity reservation", { timeout: 5_000 }, async () => {
  const clock = new ManualClock();
  const release = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting({ clock });
  const allows = mock.ports.authorization.allows;
  mock.ports.authorization.allows = async (action, context) => {
    if (action === "accept") await release.promise;
    return allows(action, context);
  };
  const pending = Array.from({ length: 32 }, (_, index) => mock.receive({ eventRef: `stalled-${index}` }));
  await new Promise(setImmediate);
  clock.advance(180_000);
  const results = await Promise.all(pending);
  assert.ok(results.every((result) => !("view" in result) && result.reason === "timeout"));
  assert.deepEqual(await mock.receive({ eventRef: "new-before-confirmed-end" }), { status: "service_unavailable", reason: "unavailable" });
  release.resolve();
  await new Promise(setImmediate);
  assert.equal((await mock.receive({ eventRef: "new-after-confirmed-end" })).status, "accepted");
  await mock.closed;
  assert.equal(mock.events.filter((event) => event.action === "logs.read").length, 1);
});

test("the same platform event in distinct trusted tenant/conversation scopes has distinct digests", { timeout: 5_000 }, async () => {
  const anotherTenant = { ...actor, tenantRef: "tenant-2" };
  const anotherConversation = { ...actor, destinationRef: "private-conversation-2" };
  const mock = createMockTroubleshooting({ authorizedActors: [actor, anotherTenant, anotherConversation] });
  const accepted = await Promise.all([mock.receive(), mock.receive(anotherTenant), mock.receive(anotherConversation)]);
  assert.ok(accepted.every((result) => result.status === "accepted"));
  for (const result of accepted) if ("view" in result) await mock.phaseClosed(1, result.view.caseRef);
  const keys = mock.events.filter((event) => event.action === "admission.confirm").map((event) => (event.input as { key: string }).key);
  assert.equal(new Set(keys).size, 3);
  assert.equal(mock.events.filter((event) => event.action === "logs.read").length, 3);
});

test("missing or malformed trusted actors are denied without disclosing case existence", { timeout: 5_000 }, async () => {
  const held = Promise.withResolvers<unknown>();
  const mock = createMockTroubleshooting({ agent: async () => held.promise });
  await mock.receive();
  for (const malformed of [null, undefined, {}, { principalRef: "principal-1" }, "principal-1"]) {
    const input = malformed as typeof actor;
    assert.deepEqual(await mock.application.get(input, "case-1"), { status: "denied" });
    assert.deepEqual(await mock.application.cancel(input, "case-1"), { status: "denied" });
  }
  await mock.application.cancel(actor, "case-1");
  held.resolve({});
});

test("Mock private ingress accepts the supported PSP business fields while rejecting authority fields", async () => {
  const { pspFixture } = await import("../fixtures/psp.js");
  const mock = createMockTroubleshooting({ pspObservation: pspFixture });
  const intake = new MockPrivateConversation(mock.application, mock.inbound);
  const request = { scenario: "psp", applicationId: "SYNTHETIC-SECRET-APPLICATION", shopId: "SYNTHETIC-SECRET-SHOP", bindingId: "SYNTHETIC-SECRET-BINDING", question: "Why?" };
  assert.equal((await intake.receive(Buffer.from(JSON.stringify(request)))).status, "accepted");
  await mock.closed;
  assert.equal((await mock.delivery.next()).report.scene, "psp");
  assert.deepEqual(await intake.receive(Buffer.from(JSON.stringify({ ...request, resourceRefs: ["psp-code"] }))), { status: "denied", reason: "invalid_request" });
});

test("completed cases release original execution contexts while durable terminal views and duplicate keys remain usable", async () => {
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
  const result = await promisify(execFile)(process.execPath, ["--expose-gc", new URL("../fixtures/case-release.js", import.meta.url).pathname], { timeout: 10_000 });
  const saved = JSON.parse(result.stdout) as { retained: number; view: { state: string }; cancel: unknown; reply: { status: string; newCaseRequired: boolean }; duplicate: { status: string }; investigations: number };
  assert.equal(saved.retained, 0); assert.equal(saved.view.state, "completed"); assert.deepEqual(saved.cancel, saved.view);
  assert.equal(saved.reply.status, "terminal"); assert.equal(saved.reply.newCaseRequired, true);
  assert.equal(saved.duplicate.status, "duplicate"); assert.equal(saved.investigations, 40);
});

test("completed cases release original execution contexts while the actual local Teams SDK host and its delivery cache remain open", async () => {
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
  const result = await promisify(execFile)(process.execPath, ["--expose-gc", new URL("../fixtures/case-release.js", import.meta.url).pathname, "teams"], { timeout: 10_000 });
  const saved = JSON.parse(result.stdout) as { retained: number; view: { state: string }; duplicate: { status: string }; investigations: number; physicalMessages: number };
  assert.equal(saved.retained, 0); assert.equal(saved.view.state, "completed"); assert.equal(saved.duplicate.status, "duplicate");
  assert.equal(saved.investigations, 40); assert.equal(saved.physicalMessages, 80);
});

test("released terminal A operations keep owner and action authorization independently of C review access", async () => {
  const technician = { principalRef: "technician", tenantRef: "tenant-1", destinationRef: "technical" }, denyActions: string[] = [];
  const mock = createMockTroubleshooting({ denyActions, recordGrants: [{ actor: technician, role: "technical", caseRefs: ["case-1"], resourceRefs: ["simulator-source"] }] });
  await mock.receive(); await mock.closed; await new Promise(setImmediate);
  assert.ok((await mock.ports.records.read(technician, "case-1"))?.scope === "full");
  assert.deepEqual(await mock.application.get(technician, "case-1"), { status: "denied" });
  assert.deepEqual(await mock.application.cancel(technician, "case-1"), { status: "denied" });
  for (const malformed of [null, undefined]) assert.equal((await mock.application.provideInformation(malformed as never)).status, "denied");
  denyActions.push("get", "cancel", "provideInformation", "accept");
  assert.ok((await mock.ports.records.read(mock.inbound, "case-1"))?.scope === "full");
  assert.deepEqual(await mock.application.get(mock.inbound, "case-1"), { status: "denied" });
  assert.deepEqual(await mock.application.cancel(mock.inbound, "case-1"), { status: "denied" });
  assert.equal((await mock.application.provideInformation({ ...mock.inbound, reply: { caseRef: "case-1", questionId: "old" }, content: {} })).status, "denied");
  assert.equal((await mock.receive()).status, "denied");
});

for (const control of ["confirmation", "accepted-audit"] as const) test(`late admission ${control} releases forty pre-investigation terminal contexts after its original work settles`, async () => {
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
  const result = await promisify(execFile)(process.execPath, ["--expose-gc", new URL("../fixtures/late-admission-release.js", import.meta.url).pathname, control], { timeout: 10_000 });
  const saved = JSON.parse(result.stdout) as { retained: number; view: { state: string; stopReason: string }; duplicate: { status: string }; investigations: number; closes: number };
  assert.equal(saved.retained, 0);
  assert.equal(saved.view.state, "stopped"); assert.equal(saved.view.stopReason, "timeout"); assert.equal(saved.duplicate.status, "duplicate");
  assert.equal(saved.investigations, 0); assert.equal(saved.closes, 40);
});

for (const action of ["cancel", "provideInformation", "get"] as const) test(`released terminal ${action} shares its original read and ends local waiting at five seconds`, async () => {
  const clock = new ManualClock(), mock = createMockTroubleshooting({ clock });
  await mock.receive(); await mock.closed; await new Promise(setImmediate);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const allows = mock.ports.authorization.allows;
  let reads = 0, answered = 0;
  mock.ports.authorization.allows = async (operation, context) => {
    if (operation === "records.read") { reads++; entered.resolve(); await release.promise; }
    return allows(operation, context);
  };
  const invoke = () => action === "provideInformation"
    ? mock.application.provideInformation({ ...mock.inbound, eventRef: `terminal-${answered}`, reply: { caseRef: "case-1", questionId: "old" }, content: {} })
    : mock.application[action](mock.inbound, "case-1");
  const pending = Array.from({ length: 32 }, () => invoke().then((result) => { answered++; return result; }));
  try {
    await entered.promise; await new Promise(setImmediate); clock.advance(5_000); await new Promise(setImmediate);
    assert.equal(answered, 32, "callers must stop waiting while their original read remains unresolved");
    assert.equal(reads, 1, "same actor, case and action share one unresolved record read");
    assert.ok((await Promise.all(pending)).every((result) => "status" in result && result.status === "denied"));
    release.resolve(); for (let turn = 0; turn < 4; turn++) await new Promise(setImmediate);
    const fresh = await invoke();
    assert.ok("state" in fresh || "status" in fresh && fresh.status === "terminal", "after the original read settles, a fresh authorization can disclose the saved terminal view");
  } finally { release.resolve(); await Promise.all(pending); await mock.application.close(); }
});

test("cancelling one restored caller leaves the shared original read and another authorized caller intact", async () => {
  const mock = createMockTroubleshooting();
  await mock.receive(); await mock.closed; await new Promise(setImmediate);
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), controller = new AbortController();
  const read = mock.ports.records.read;
  let reads = 0, secondAnswered = false;
  mock.ports.records.read = async (...args) => { reads++; entered.resolve(); await release.promise; return read(...args); };
  const first = mock.application.cancel(mock.inbound, "case-1", controller.signal);
  const second = mock.application.cancel(mock.inbound, "case-1").then((result) => { secondAnswered = true; return result; });
  try {
    await entered.promise; controller.abort();
    assert.deepEqual(await first, { status: "denied" }); assert.equal(secondAnswered, false); assert.equal(reads, 1);
    release.resolve();
    const saved = await second; assert.ok("state" in saved); assert.equal(saved.state, "completed");
    assert.equal(reads, 1);
  } finally { release.resolve(); await Promise.all([first, second]); await mock.application.close(); }
});

test("expired distinct restored reads retain a finite capacity and shutdown ownership until their original operations settle", async () => {
  const clock = new ManualClock(), mock = createMockTroubleshooting({ clock });
  const release = Promise.withResolvers<void>(), read = mock.ports.records.read;
  let reads = 0, closed = false;
  mock.ports.records.read = async (...args) => { reads++; await release.promise; return read(...args); };
  const pending = Array.from({ length: 32 }, (_, index) => mock.application.get(mock.inbound, `missing-${index}`));
  await new Promise(setImmediate); clock.advance(5_000);
  try {
    assert.ok((await Promise.all(pending)).every((result) => "status" in result && result.status === "denied"));
    assert.deepEqual(await mock.application.get(mock.inbound, "one-more"), { status: "denied" }); assert.equal(reads, 32);
    const closing = mock.application.close().then(() => { closed = true; });
    await new Promise(setImmediate); clock.advance(5_000); await new Promise(setImmediate); assert.equal(closed, false);
    release.resolve(); await closing; assert.equal(closed, true);
  } finally { release.resolve(); await mock.application.close(); }
});

test("timed out restored disclosure callbacks remain bounded and owned until their original host work settles", async () => {
  const clock = new ManualClock(), mock = createMockTroubleshooting({ clock });
  await mock.receive(); await mock.closed; await new Promise(setImmediate);
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let disclosures = 0, closed = false;
  const beforeDisclose = async () => { if (++disclosures === 32) entered.resolve(); await release.promise; };
  const pending = Array.from({ length: 32 }, () => mock.application.get(mock.inbound, "case-1", beforeDisclose));
  try {
    await entered.promise; clock.advance(5_000);
    assert.ok((await Promise.all(pending)).every((result) => "status" in result && result.status === "denied"));
    assert.deepEqual(await mock.application.get(mock.inbound, "case-1", beforeDisclose), { status: "denied" }); assert.equal(disclosures, 32);
    const closing = mock.application.close().then(() => { closed = true; });
    await new Promise(setImmediate); assert.equal(closed, false);
    release.resolve(); await closing; assert.equal(closed, true);
  } finally { release.resolve(); await mock.application.close(); }
});

test("callers sharing a restored terminal query receive independent view snapshots", async () => {
  const mock = createMockTroubleshooting();
  await mock.receive(); await mock.closed; await new Promise(setImmediate);
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), read = mock.ports.records.read;
  mock.ports.records.read = async (...args) => { entered.resolve(); await release.promise; return read(...args); };
  try {
    const pending = [mock.application.cancel(mock.inbound, "case-1"), mock.application.cancel(mock.inbound, "case-1")];
    await entered.promise; release.resolve(); const [first, second] = await Promise.all(pending);
    assert.ok(first && "state" in first && second && "state" in second);
    (first as { phaseId: number }).phaseId = 999;
    assert.equal(second.phaseId, 1);
    const saved = await mock.ports.records.read(mock.inbound, "case-1"); assert.ok(saved?.scope === "full"); assert.equal(saved.view.phaseId, 1);
  } finally { release.resolve(); await mock.application.close(); }
});

test("shutdown cannot confirm closure when a late pre-investigation admission's original Agent close fails", async () => {
  const mock = createMockTroubleshooting(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const confirm = mock.ports.admission.confirm;
  mock.ports.admission.confirm = async (record) => { entered.resolve(); await release.promise; return confirm(record); };
  let investigations = 0, closes = 0;
  mock.ports.agent.run = async () => { investigations++; return {}; };
  mock.ports.agent.close = async () => { closes++; throw new Error("synthetic-unconfirmed-close"); };
  const accepting = mock.receive(); await entered.promise;
  const closing = mock.application.close();
  const checked = assert.rejects(closing, /unavailable/);
  release.resolve();
  const result = await accepting; assert.equal(result.status, "service_unavailable");
  await checked; assert.equal(investigations, 0); assert.equal(closes, 1);
});

for (const mode of ["paused", "paused-teams"] as const) test(`${mode} cancelled clarification cases release forty original contexts after case controls settle`, async () => {
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
  const result = await promisify(execFile)(process.execPath, ["--expose-gc", new URL("../fixtures/case-release.js", import.meta.url).pathname, mode], { timeout: 10_000 });
  const saved = JSON.parse(result.stdout) as { retained: number; view: { state: string; stopReason: string }; duplicate: { status: string }; closures: number; investigations: number; physicalMessages?: number };
  assert.equal(saved.retained, 0); assert.equal(saved.view.state, "stopped"); assert.equal(saved.view.stopReason, "cancelled");
  assert.equal(saved.duplicate.status, "duplicate"); assert.equal(saved.closures, 40); assert.equal(saved.investigations, 0);
  if (mode === "paused-teams") assert.equal(saved.physicalMessages, 120);
});
