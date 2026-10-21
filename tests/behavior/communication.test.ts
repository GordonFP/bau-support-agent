import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";

test("accepted cases send a fixed sanitized status through D with a durable child intent", async () => {
  const mock = createMockTroubleshooting();
  await mock.receive(); await mock.closed;
  const status = mock.events.find((event) => event.action === "delivery.notice");
  assert.ok(status, "the accepted status must be delivered through the controlled D port");
  assert.deepEqual((status.input as { notice: unknown }).notice, { kind: "status", state: "accepted", caseRef: "case-1" });
  const stored = await mock.ports.records.read(mock.inbound, "case-1");
  assert.ok(stored?.scope === "full");
  assert.ok(stored.deliveries.some((item) => item.deliveryKey === "case-1:status:1" && item.segment === 1 && item.status === "delivered"));
});

test("ambiguous applications push the fixed question through D before waiting for a trusted reply", async () => {
  const mock = createMockTroubleshooting({ customerCandidates: [
    { applicationId: "SYNTHETIC-SECRET-APPLICATION", submittedAt: "2026-10-18T10:00:00.000Z" },
    { applicationId: "SYNTHETIC-SECRET-APPLICATION-SECOND", submittedAt: "2026-10-18T15:00:00.000Z" },
  ] });
  await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } }); await mock.closed;
  const notices = mock.events.filter((event) => event.action === "delivery.notice");
  const question = notices.map((event) => (event.input as { notice: { kind: string; question?: { questionId: string } } }).notice).find((notice) => notice.kind === "question");
  assert.equal(question?.question?.questionId, "case-1:question:1");
  assert.doesNotMatch(JSON.stringify(notices), /SYNTHETIC-SECRET/);
  const stored = await mock.ports.records.read(mock.inbound, "case-1");
  assert.ok(stored?.scope === "full");
  assert.equal(stored.view.state, "awaiting_input");
  assert.ok(stored.deliveries.some((item) => item.deliveryKey === "case-1:question:1" && item.status === "delivered"));
});

test("a smaller D limit creates independently audited children and stops at the first unknown segment", async () => {
  const mock = createMockTroubleshooting();
  Object.assign(mock.ports.delivery, { maxTextBytes: 1_024 });
  const writes: { text: string; segment: number; key: string }[] = [];
  mock.ports.delivery.send = async (_destination, _report, key, attempt) => {
    assert.ok(attempt); await attempt.beforeWrite();
    writes.push({ text: attempt.text, segment: attempt.segment, key });
    return writes.length === 2 ? "unknown" : "delivered";
  };
  await mock.receive(); await mock.closed;
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map((write) => write.segment), [1, 2]);
  assert.ok(writes.every((write) => write.key === "case-1:report:1" && Buffer.byteLength(write.text) <= 1_024));
  const stored = await mock.ports.records.read(mock.inbound, "case-1");
  assert.ok(stored?.scope === "full");
  assert.deepEqual(stored.deliveries.filter((item) => item.deliveryKey === "case-1:report:1").map((item) => [item.segment, item.status]), [[1, "delivered"], [2, "unknown"]]);
  const duplicate = await mock.receive(); assert.equal(duplicate.status, "duplicate"); assert.equal(writes.length, 2);
});

test("an unknown accepted-status write stops before investigation instead of disclosing a later report", async () => {
  const mock = createMockTroubleshooting();
  mock.ports.delivery.notice = async () => "unknown";
  await mock.receive(); await mock.closed;
  assert.equal(mock.events.some((event) => ["logs.read", "model.generate", "delivery.send"].includes(event.action)), false);
  const view = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in view); assert.equal(view.state, "stopped");
});

for (const failure of ["revoked", "null", "status", "receipt", "receipt_object"] as const) test(`D completes persisted send intent after ${failure}`, async () => {
  const denyActions: string[] = [];
  const mock = createMockTroubleshooting({ denyActions, controlPorts: (ports) => {
    const audit = ports.audit;
    return { audit: { ...audit, intent: async (context, action, details) => {
      const result = await audit.intent(context, action, details);
      if (action === "delivery.send" && failure === "revoked") denyActions.push(action);
      return result;
    } } };
  } });
  let writes = 0;
  mock.ports.delivery.send = async () => { writes++; return (failure === "null" ? null : failure === "status" ? { status: "invalid" } : failure === "receipt_object" ? { status: "delivered", receiptRef: { toString: () => "a".repeat(64) } } : { status: "delivered", receiptRef: "invalid" }) as never; };
  await mock.receive(); await mock.closed;
  const stored = await mock.ports.records.read(mock.inbound, "case-1");
  assert.ok(stored?.scope === "full");
  const completions = stored.audits.filter((entry) => entry.action === "delivery.send" && entry.stage === "complete");
  assert.equal(completions.length, 1);
  assert.equal(completions[0]!.outcome, failure === "revoked" ? "failed" : "unknown");
  assert.equal(stored.deliveries.find((item) => item.deliveryKey === "case-1:report:1")?.status, failure === "revoked" ? "failed" : "unknown");
  assert.equal(writes, failure === "revoked" ? 0 : 1);
  await mock.receive(); assert.equal(writes, failure === "revoked" ? 0 : 1);
});
