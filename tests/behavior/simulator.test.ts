import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting, simulatorFixture } from "../../src/adapters/mock/troubleshooting.js";

test("a cross-day request reports the submitted tenth shop's D-1 coverage gap", async () => {
  const mock = createMockTroubleshooting();
  const acceptance = await mock.receive();
  assert.equal(acceptance.status, "accepted");
  const { report, destinationRef } = await mock.delivery.next();
  assert.equal(destinationRef, "private-conversation-1");
  assert.equal(report.simulator.submittedOn, "2026-10-18");
  assert.deepEqual(report.simulator.dataReadiness, { satisfied: 9, missing: 1, unknown: 0 });
  assert.deepEqual(report.simulator.shops[9], {
    shopRef: "shop-10", authorization: "active", targetDate: "2026-10-18",
    completeThrough: "2026-10-17", readiness: "missing", evidenceRefs: report.evidence.filter((item) => item.kind === "log").map((item) => item.evidenceRef),
  });
  assert.equal(report.diagnosticStatus, "lead");
  assert.equal(report.possibleCauses.length, 0);
  assert.match(report.humanNextSteps.join(" "), /shop-10/);
});

test("unsafe Agent output is rejected before disclosure rather than repaired into an accepted report", async () => {
  const mock = createMockTroubleshooting({ agent: async (_context, request) => {
    await request.invoke("logs.read", null);
    await request.invoke("code.search", null);
    return { ...request.diagnose(), problem: "Why is SYNTHETIC-SECRET-APPLICATION still waiting?" };
  } });
  const acceptance = await mock.receive();
  assert.equal(acceptance.status, "accepted");
  if (acceptance.status !== "accepted") return;
  await mock.closed;
  const view = await mock.application.get(mock.inbound, acceptance.view.caseRef);
  assert.ok("state" in view);
  assert.equal(view.state, "stopped");
  assert.equal(view.stopReason, "unsafe_content");
  assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
});

test("published evidence retains actual audit receipts, observation times and the immutable code snapshot", async () => {
  const mock = createMockTroubleshooting();
  await mock.receive();
  const { report } = await mock.delivery.next();
  const intents = mock.events.filter((event) => event.action.endsWith(":intent"))
    .map((event) => `${(event.input as { callId: string }).callId}:intent`);
  assert.ok(report.evidence.every((evidence) => intents.includes(evidence.auditRef)));
  assert.equal(report.evidence[0]?.observedAt, "2026-10-18T23:00:00.000Z");
  assert.deepEqual(report.evidence[1]?.code, {
    repositoryRef: "simulator-source", branch: "main", commit: "1111111111111111111111111111111111111111",
    snapshotRef: "simulator-snapshot-1", indexedAt: "2026-10-19T08:00:00.000Z", receiptRef: "synthetic-snapshot-receipt-1",
  });
});

test("complete shop data leaves execution, calculation success and estimate explicitly unknown", async () => {
  const mock = createMockTroubleshooting({ observation: { ...simulatorFixture,
    shops: simulatorFixture.shops.map((shop) => ({ ...shop, completeThrough: "2026-10-18" })) } });
  await mock.receive();
  const { report } = await mock.delivery.next();
  assert.deepEqual(report.simulator.dataReadiness, { satisfied: 10, missing: 0, unknown: 0 });
  assert.deepEqual(report.simulator.calculation, { started: null, succeeded: null, estimate: null });
  assert.equal(report.possibleCauses.length, 0);
  assert.equal(report.facts.length, 1);
  assert.match(report.humanNextSteps[0]!, /execution, success and the estimate result separately/);
});

test("evidence from another application is not accepted as support for this case", async () => {
  const mock = createMockTroubleshooting({ evidenceTargetRef: "application-other" });
  const acceptance = await mock.receive();
  assert.equal(acceptance.status, "accepted");
  if (acceptance.status !== "accepted") return;
  await mock.closed;
  const view = await mock.application.get(mock.inbound, acceptance.view.caseRef);
  assert.ok("state" in view);
  assert.equal(view.state, "stopped");
  assert.equal(view.stopReason, "invalid_request");
  assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send"), false);
});

test("a source observation must match the application selected by the inbound request", async () => {
  const mock = createMockTroubleshooting();
  const acceptance = await mock.receive({ input: { applicationId: "OTHER-SYNTHETIC-APP", question: "Why is it waiting?" } });
  assert.equal(acceptance.status, "accepted");
  if (acceptance.status !== "accepted") return;
  await mock.closed;
  const view = await mock.application.get(mock.inbound, acceptance.view.caseRef);
  assert.ok("state" in view);
  assert.equal(view.state, "stopped");
  assert.equal(view.stopReason, "invalid_request");
});

test("a valid model candidate remains valid when UTC time advances during generation", async () => {
  let utc = "2026-10-19T09:00:00.000Z";
  const mock = createMockTroubleshooting({ clock: { now: () => 0, utc: () => utc }, candidate: (draft) => {
    utc = "2026-10-19T09:00:01.000Z";
    return draft;
  } });
  const acceptance = await mock.receive();
  assert.equal(acceptance.status, "accepted");
  if (acceptance.status !== "accepted") return;
  await mock.closed;
  const view = await mock.application.get(mock.inbound, acceptance.view.caseRef);
  assert.ok("state" in view);
  assert.equal(view.state, "completed");
});

test("input that cannot be safely sanitized is refused before retrieval or model use", async () => {
  const mock = createMockTroubleshooting();
  const acceptance = await mock.receive({ input: { ...mock.inbound.input, question: "<script>unsafe synthetic input</script>" } });
  assert.deepEqual(acceptance, { status: "denied", reason: "unsafe_content" });
  assert.equal(mock.events.some((event) => ["logs.read", "code.search", "model.generate", "delivery.send"].includes(event.action)), false);
});

test("missing observations produce evidence insufficiency without inventing an event's absence", async () => {
  const mock = createMockTroubleshooting({ observation: null, completeness: "unknown" });
  await mock.receive();
  const { report } = await mock.delivery.next();
  assert.equal(report.diagnosticStatus, "insufficient_evidence");
  assert.deepEqual(report.facts, []);
  assert.deepEqual(report.possibleCauses, []);
  assert.match(report.limitations.join(" "), /zero observations do not prove/);
});

test("unknown coverage is not counted as complete, and partial source limits remain visible", async () => {
  const mock = createMockTroubleshooting({ completeness: "partial", observation: { ...simulatorFixture,
    shops: simulatorFixture.shops.map((shop, index) => index === 9 ? { ...shop, completeThrough: null, coverageComplete: false } : shop) } });
  await mock.receive();
  const { report } = await mock.delivery.next();
  assert.deepEqual(report.simulator.dataReadiness, { satisfied: 9, missing: 0, unknown: 1 });
  assert.equal(report.simulator.shops[9]?.readiness, "unknown");
  assert.match(report.limitations.join(" "), /partial/);
});

test("an unapproved principal cannot trigger retrieval, a model call or disclosure", async () => {
  const mock = createMockTroubleshooting({ principalRef: "unapproved-principal" });
  assert.deepEqual(await mock.receive(), { status: "denied", reason: "denied" });
  assert.equal(mock.events.some((event) => ["logs.read", "code.search", "model.generate", "delivery.send"].includes(event.action)), false);
  assert.ok(mock.events.some((event) => event.action === "audit:authorization.denied:complete"));
});

test("revoked source access is denied before that source, model or delivery is called", async () => {
  const mock = createMockTroubleshooting({ denyActions: ["logs.read"] });
  const acceptance = await mock.receive();
  assert.equal(acceptance.status, "accepted");
  if (acceptance.status !== "accepted") return;
  await mock.closed;
  const view = await mock.application.get(mock.inbound, acceptance.view.caseRef);
  assert.ok("state" in view);
  assert.equal(view.stopReason, "denied");
  assert.equal(mock.events.some((event) => ["logs.read", "code.search", "model.generate", "delivery.send"].includes(event.action)), false);
});

test("an Agent request for an unlisted tool cannot reach any external capability", async () => {
  const mock = createMockTroubleshooting({ agent: async (_context, request) => request.invoke("shell", { command: "synthetic" }) });
  const acceptance = await mock.receive();
  assert.equal(acceptance.status, "accepted");
  if (acceptance.status !== "accepted") return;
  await mock.closed;
  const view = await mock.application.get(mock.inbound, acceptance.view.caseRef);
  assert.ok("state" in view);
  assert.equal(view.stopReason, "denied");
  assert.equal(mock.events.some((event) => ["logs.read", "code.search", "model.generate", "delivery.send"].includes(event.action)), false);
});

for (const reference of ["missing-evidence", "other-case:log:0"]) {
  test(`a candidate citing ${reference} cannot be disclosed`, async () => {
    const mock = createMockTroubleshooting({ candidate: (draft) => ({ ...draft,
      facts: [{ ...draft.facts[0], evidenceRefs: [reference] }] }) });
    const acceptance = await mock.receive();
    assert.equal(acceptance.status, "accepted");
    if (acceptance.status !== "accepted") return;
    await mock.closed;
    const view = await mock.application.get(mock.inbound, acceptance.view.caseRef);
    assert.ok("state" in view);
    assert.equal(view.stopReason, "unsafe_content");
    assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
  });
}

test("unavailable authorization, sanitization, audit or budget controls keep the path closed", async () => {
  for (const control of ["authorization", "sanitization", "audit", "budget"] as const) {
    const mock = createMockTroubleshooting({ unavailableControls: [control] });
    assert.deepEqual(await mock.receive(), { status: "service_unavailable", reason: "unavailable" });
    assert.deepEqual(mock.events, []);
  }
});

test("input and source identifiers are sanitized before the model, report and audit exits", async () => {
  const mock = createMockTroubleshooting();
  const acceptance = await mock.receive();
  assert.equal(acceptance.status, "accepted");
  const { report } = await mock.delivery.next();
  await mock.closed;
  const controlledOutputs = mock.events.filter((event) => event.action !== "logs.read");
  assert.equal(JSON.stringify(controlledOutputs).includes("SYNTHETIC-SECRET-APPLICATION"), false);
  assert.match(report.problem, /\[case-1:application\]/);
  assert.equal(report.targetSummary, "[case-1:application]");
  assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 1_000);
});

test("missing source intent audit prevents the source call and all later disclosure", async () => {
  const mock = createMockTroubleshooting({ auditFails: "logs.read:intent" });
  const acceptance = await mock.receive();
  assert.equal(acceptance.status, "accepted");
  if (acceptance.status !== "accepted") return;
  await mock.closed;
  const view = await mock.application.get(mock.inbound, acceptance.view.caseRef);
  assert.ok("state" in view);
  assert.equal(view.stopReason, "audit_unavailable");
  assert.equal(mock.events.some((event) => ["logs.read", "code.search", "model.generate", "delivery.send"].includes(event.action)), false);
});

test("current disclosure authorization is checked even after a safe report has been generated", async () => {
  const mock = createMockTroubleshooting({ denyActions: ["delivery.send"] });
  const acceptance = await mock.receive();
  assert.equal(acceptance.status, "accepted");
  if (acceptance.status !== "accepted") return;
  await mock.closed;
  const view = await mock.application.get(mock.inbound, acceptance.view.caseRef);
  assert.ok("state" in view);
  assert.equal(view.stopReason, "denied");
  assert.equal(mock.events.some((event) => event.action === "model.generate"), true);
  assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
});

test("an asynchronous startup sanitization failure ends safely and cleans up the case", async () => {
  const mock = createMockTroubleshooting({ sanitizeFailsAt: 2 });
  const acceptance = await mock.receive();
  assert.equal(acceptance.status, "accepted");
  if (acceptance.status !== "accepted") return;
  await mock.closed;
  const view = await mock.application.get(mock.inbound, acceptance.view.caseRef);
  assert.ok("state" in view);
  assert.equal(view.state, "stopped");
  assert.equal(view.stopReason, "unavailable");
  assert.equal(JSON.stringify(view).includes("synthetic-sensitive-upstream-error"), false);
  assert.equal(mock.events.some((event) => ["logs.read", "code.search", "model.generate", "delivery.send"].includes(event.action)), false);
});

test("diagnosing before tools does not discard evidence accepted later in the same phase", async () => {
  const mock = createMockTroubleshooting({ agent: async (_context, request) => {
    request.diagnose();
    await request.invoke("logs.read", null);
    await request.invoke("code.search", null);
    return request.generate(request.diagnose());
  } });
  await mock.receive();
  const { report } = await mock.delivery.next();
  assert.equal(report.simulator.shopCount, 10);
  assert.deepEqual(report.simulator.dataReadiness, { satisfied: 9, missing: 1, unknown: 0 });
  assert.equal(report.simulator.shops[9]?.shopRef, "shop-10");
  assert.equal(report.evidence.length, 2);
  assert.equal(report.targetSummary, "[case-1:application]");
});
