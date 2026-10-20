import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";

test("a failed source result audit stops investigation and sends one fixed data-free fault without retrying that audit path", async () => {
  const mock = createMockTroubleshooting();
  const complete = mock.ports.audit.complete;
  let failed = false;
  const subsequentAudits: string[] = [];
  mock.ports.audit.complete = async (context, action, outcome) => {
    if (failed) subsequentAudits.push(action);
    if (action === "logs.read") { failed = true; throw new Error("SYNTHETIC-SECRET-audit-path"); }
    return complete(context, action, outcome);
  };
  const intent = mock.ports.audit.intent;
  mock.ports.audit.intent = async (context, action) => {
    if (failed) subsequentAudits.push(action);
    return intent(context, action);
  };
  await mock.receive();
  await mock.closed;
  await new Promise(setImmediate);
  assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send"), false);
  const notices = mock.events.filter((event) => event.action === "delivery.fault");
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0]!.input, { destinationRef: "private-conversation-1", notice: "Investigation stopped because audit storage is unavailable.", deliveryKey: "case-1:audit-fault" });
  assert.deepEqual(subsequentAudits, []);
});

for (const failure of ["model.generate:complete", "delivery.send:intent", "delivery.send:complete"] as const) {
  test(`${failure} allows only one fixed fault notice after audit loss`, async () => {
    const mock = createMockTroubleshooting({ auditFails: failure });
    await mock.receive();
    await mock.closed;
    await new Promise(setImmediate);
    assert.equal(mock.events.filter((event) => event.action === "delivery.send").length, failure === "delivery.send:complete" ? 1 : 0);
    assert.equal(mock.events.filter((event) => event.action === "delivery.fault").length, 1);
    const view = await mock.application.get(mock.inbound, "case-1");
    assert.ok("state" in view);
    assert.equal(view.stopReason, "audit_unavailable");
    if (failure === "delivery.send:complete") assert.equal(view.deliveryStatus, "unknown");
  });
}

test("an old phase's late result audit failure stops the resumed phase before it can disclose its report", { timeout: 5_000 }, async () => {
  const old = Promise.withResolvers<void>();
  const current = Promise.withResolvers<void>();
  const modelStarted = Promise.withResolvers<void>();
  const oldModelStarted = Promise.withResolvers<void>();
  const candidate = { applicationId: "SYNTHETIC-SECRET-APPLICATION", submittedAt: "2026-10-18T10:00:00Z" };
  const mock = createMockTroubleshooting({ customerCandidates: [candidate,
    { ...candidate, applicationId: "SYNTHETIC-SECRET-APPLICATION-SECOND", submittedAt: "2026-10-18T15:00:00Z" }],
    model: async (context, draft) => {
      if (context.phaseId === 1) { oldModelStarted.resolve(); await old.promise; }
      else { modelStarted.resolve(); await current.promise; }
      return { candidate: draft, actualMicrousd: null };
    }, agent: async (context, request) => {
      if (context.phaseId === 1) {
        void request.generate(request.diagnose()).catch(() => {});
        await oldModelStarted.promise;
      }
      await request.invoke("logs.read", null);
      await request.invoke("code.search", null);
      return request.generate(request.diagnose());
    } });
  const complete = mock.ports.audit.complete;
  mock.ports.audit.complete = async (context, action, outcome) => {
    if (context.phaseId === 1 && action === "model.generate" && outcome === "discarded") throw new Error("synthetic-audit-failure");
    return complete(context, action, outcome);
  };
  await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  await mock.phaseClosed(1);
  const reply = await mock.application.provideInformation({ principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1",
    eventRef: "reply-1", receivedAt: "2026-10-19T09:01:00Z", reply: { caseRef: "case-1", questionId: "case-1:question:1" }, content: { submittedAt: candidate.submittedAt } });
  assert.equal(reply.status, "resumed");
  await modelStarted.promise;
  old.resolve();
  await new Promise(setImmediate);
  current.resolve();
  await mock.phaseClosed(2);
  await new Promise(setImmediate);
  assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
  assert.equal(mock.events.filter((event) => event.action === "delivery.fault").length, 1);
  const view = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in view);
  assert.equal(view.phaseId, 2);
  assert.equal(view.stopReason, "audit_unavailable");
});

test("authorization denials are safely audited without starting any external business action", async () => {
  const mock = createMockTroubleshooting({ principalRef: "intruder" });
  assert.deepEqual(await mock.receive(), { status: "denied", reason: "denied" });
  assert.equal(mock.events.some((event) => ["logs.read", "model.generate", "delivery.send"].includes(event.action)), false);
  assert.ok(mock.events.some((event) => event.action === "audit:authorization.denied:complete" && (event.input as { outcome: string }).outcome === "denied"));
  assert.doesNotMatch(JSON.stringify(mock.events), /SYNTHETIC-SECRET/);
});
