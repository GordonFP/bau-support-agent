import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting, simulatorFixture } from "../../src/adapters/mock/troubleshooting.js";
import { ManualClock } from "../fixtures/clock.js";
import type { InformationReply } from "../../src/troubleshooting/application/ports.js";

const candidates = [
  { applicationId: "SYNTHETIC-SECRET-APPLICATION", submittedAt: "2026-10-18T10:00:00.000Z" },
  { applicationId: "SYNTHETIC-SECRET-APPLICATION-SECOND", submittedAt: "2026-10-18T15:00:00.000Z" },
];

const trustedReply = (content: InformationReply["content"], eventRef = "reply-1"): InformationReply => ({
  principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1", eventRef,
  receivedAt: "2026-10-19T09:00:01.000Z", reply: { caseRef: "case-1", questionId: "case-1:question:1" }, content,
});

test("code evidence accepted before clarification and after resume keeps distinct retrieval provenance", { timeout: 5_000 }, async () => {
  const mock = createMockTroubleshooting({ customerCandidates: candidates, agent: async (_context, request) => {
    await request.invoke("code.search", null);
    await request.invoke("logs.read", null);
    return request.generate(request.diagnose());
  } });
  await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  await mock.phaseClosed(1);
  const resumed = await mock.application.provideInformation(trustedReply({ submittedAt: candidates[0]!.submittedAt }));
  assert.equal(resumed.status, "resumed");
  await mock.phaseClosed(2);
  const view = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in view);
  assert.equal(view.state, "completed");
  const { report } = await mock.delivery.next();
  const code = report.evidence.filter((item) => item.kind === "code");
  assert.equal(code.length, 2);
  assert.equal(new Set(code.map((item) => item.evidenceRef)).size, 2);
  assert.equal(new Set(code.map((item) => item.auditRef)).size, 2);
});

test("a customer with two applications is asked for submission time before either application is investigated", { timeout: 5_000 }, async () => {
  const mock = createMockTroubleshooting({ customerCandidates: [
    { applicationId: "SYNTHETIC-SECRET-APPLICATION", submittedAt: "2026-10-18T10:00:00.000Z" },
    { applicationId: "SYNTHETIC-SECRET-APPLICATION-SECOND", submittedAt: "2026-10-18T15:00:00.000Z" },
  ] });
  const accepted = await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why is the calculation waiting?" } });
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;
  await mock.closed;
  const view = await mock.application.get(mock.inbound, accepted.view.caseRef);
  assert.ok("state" in view);
  assert.equal(view.state, "awaiting_input");
  assert.equal(view.deadlineAt, undefined);
  assert.deepEqual(view.question?.requiredFields, ["submittedAt"]);
  assert.deepEqual(view.question?.candidates, [
    { candidateRef: "candidate-1", submittedAt: "2026-10-18T10:00:00.000Z" },
    { candidateRef: "candidate-2", submittedAt: "2026-10-18T15:00:00.000Z" },
  ]);
  assert.equal(mock.events.some((event) => ["code.search", "model.generate", "delivery.send"].includes(event.action)), false);
});

test("a valid trusted reply resumes the same case with a new 180-second phase after a long wait", { timeout: 5_000 }, async () => {
  let elapsed = 0;
  const clock = { now: () => elapsed, utc: () => new Date(Date.parse("2026-10-19T09:00:00.000Z") + elapsed).toISOString() };
  const mock = createMockTroubleshooting({ customerCandidates: candidates, clock });
  const accepted = await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why is it waiting?" } });
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;
  await mock.closed;
  elapsed = 3_600_000;
  const reply = await mock.application.provideInformation({ principalRef: "principal-1", tenantRef: "tenant-1",
    destinationRef: "private-conversation-1", eventRef: "reply-1", receivedAt: clock.utc(),
    reply: { caseRef: accepted.view.caseRef, questionId: "case-1:question:1" },
    content: { submittedAt: "2026-10-18T10:00:00.000Z" } });
  assert.equal(reply.status, "resumed");
  assert.ok("view" in reply);
  assert.equal(reply.view.caseRef, accepted.view.caseRef);
  assert.equal(reply.view.phaseId, 2);
  assert.equal(reply.view.phaseStartedAt, "2026-10-19T10:00:00.000Z");
  assert.equal(reply.view.deadlineAt, "2026-10-19T10:03:00.000Z");
  const { report } = await mock.delivery.next();
  assert.equal(report.caseRef, accepted.view.caseRef);
  assert.ok(report.scene === "simulator");
  assert.equal(report.simulator.submittedOn, "2026-10-18");
  assert.equal(mock.events.filter((event) => event.action === "logs.read").length, 2);
});

test("model attempts, source rows and spending remain cumulative after a valid reply", { timeout: 5_000 }, async () => {
  const mock = createMockTroubleshooting({ customerCandidates: candidates, agent: async (context, request) => {
    if (context.phaseId === 1) await request.generate(request.diagnose());
    await request.invoke("logs.read", null);
    await request.invoke("code.search", null);
    return request.generate(request.diagnose());
  } });
  const accepted = await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;
  await mock.closed;
  const resumed = await mock.application.provideInformation({ principalRef: "principal-1", tenantRef: "tenant-1",
    destinationRef: "private-conversation-1", eventRef: "reply-1", receivedAt: "2026-10-19T09:00:01.000Z",
    reply: { caseRef: accepted.view.caseRef, questionId: "case-1:question:1" }, content: { submittedAt: candidates[0]!.submittedAt } });
  assert.equal(resumed.status, "resumed");
  await mock.delivery.next();
  const view = await mock.application.get(mock.inbound, accepted.view.caseRef);
  assert.ok("state" in view);
  assert.deepEqual(view.usage, { modelAttempts: 2, logRecords: 2, logCoverageMs: 86_400_000 });
  assert.equal((await mock.ports.budget.status(accepted.view.caseRef)).reservedMicrousd, 2_000);
});

test("the phase remains active at 179 seconds and stops at 180 even when an Agent has not settled", { timeout: 5_000 }, async () => {
  const clock = new ManualClock();
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<unknown>();
  const mock = createMockTroubleshooting({ clock, agent: async () => { started.resolve(); return result.promise; } });
  const accepted = await mock.receive();
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;
  await started.promise;
  try {
    clock.advance(179_000);
    const before = await mock.application.get(mock.inbound, accepted.view.caseRef);
    assert.ok("state" in before);
    assert.equal(before.state, "investigating");
    clock.advance(1_000);
    const expired = await mock.application.get(mock.inbound, accepted.view.caseRef);
    assert.ok("state" in expired);
    assert.equal(expired.state, "stopped");
    assert.equal(expired.stopReason, "timeout");
    assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
  } finally { result.resolve({}); await mock.closed; }
});

test("waiting pauses the phase clock but remains in UTC history and total elapsed time", { timeout: 5_000 }, async () => {
  const clock = new ManualClock();
  const mock = createMockTroubleshooting({ customerCandidates: candidates, clock });
  const accepted = await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;
  await mock.closed;
  clock.advance(3_600_000);
  clock.fireCapturedTimer(0);
  const waiting = await mock.application.get(mock.inbound, accepted.view.caseRef);
  assert.ok("state" in waiting);
  assert.equal(waiting.state, "awaiting_input");
  assert.equal(waiting.elapsedMs, 3_600_000);
  const resumed = await mock.application.provideInformation({ principalRef: "principal-1", tenantRef: "tenant-1",
    destinationRef: "private-conversation-1", eventRef: "reply-1", receivedAt: clock.utc(),
    reply: { caseRef: accepted.view.caseRef, questionId: "case-1:question:1" }, content: { submittedAt: candidates[0]!.submittedAt } });
  assert.equal(resumed.status, "resumed");
  await mock.delivery.next();
  const complete = await mock.application.get(mock.inbound, accepted.view.caseRef);
  assert.ok("state" in complete);
  assert.equal(complete.receivedAt, "2026-10-19T09:00:00.000Z");
  assert.equal(complete.acceptedAt, "2026-10-19T09:00:00.000Z");
  assert.equal(complete.phases[0]?.startedAt, "2026-10-19T09:00:00.000Z");
  assert.equal(complete.phases[1]?.startedAt, "2026-10-19T10:00:00.000Z");
  assert.deepEqual(complete.inputWaits, [{ questionId: "case-1:question:1", startedAt: "2026-10-19T09:00:00.000Z",
    endedAt: "2026-10-19T10:00:00.000Z", replyEventRef: "reply-1", replyReceivedAt: "2026-10-19T10:00:00.000Z" }]);
  assert.equal(complete.elapsedMs, 3_600_000);
});

test("an unsettled old model keeps its reservation and its late result cannot replace the resumed report", { timeout: 5_000 }, async () => {
  const firstModelStarted = Promise.withResolvers<void>();
  const oldModel = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting({ customerCandidates: candidates,
    model: async (context, draft) => {
      if (context.phaseId === 1) { firstModelStarted.resolve(); await oldModel.promise; }
      return { candidate: draft, actualMicrousd: context.phaseId === 1 ? null : 1_000 };
    },
    agent: async (context, request) => {
      if (context.phaseId === 1) {
        const pending = request.generate(request.diagnose()).catch(() => undefined);
        await firstModelStarted.promise;
        try { return await request.invoke("logs.read", null); } finally { await pending; }
      }
      await request.invoke("logs.read", null);
      await request.invoke("code.search", null);
      return request.generate(request.diagnose());
    } });
  const accepted = await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;
  await mock.aborted;
  assert.equal((await mock.ports.budget.status(accepted.view.caseRef)).reservedMicrousd, 180_000);
  const resumed = await mock.application.provideInformation({ principalRef: "principal-1", tenantRef: "tenant-1",
    destinationRef: "private-conversation-1", eventRef: "reply-1", receivedAt: "2026-10-19T09:00:01.000Z",
    reply: { caseRef: accepted.view.caseRef, questionId: "case-1:question:1" }, content: { submittedAt: candidates[0]!.submittedAt } });
  assert.equal(resumed.status, "resumed");
  const { report } = await mock.delivery.next();
  await mock.phaseClosed(2);
  oldModel.resolve();
  await mock.phaseClosed(1);
  const view = await mock.application.get(mock.inbound, accepted.view.caseRef);
  assert.ok("state" in view);
  assert.equal(view.state, "completed");
  assert.equal(view.phaseId, 2);
  assert.equal(view.reportRef, report.reportRef);
  assert.ok(report.scene === "simulator");
  assert.equal(report.simulator.submittedOn, "2026-10-18");
  assert.equal(mock.events.filter((event) => event.action === "delivery.send").length, 1);
  assert.equal((await mock.ports.budget.status(accepted.view.caseRef)).reservedMicrousd, 181_000);
  const calls = mock.events.filter((event) => event.action === "audit:model.generate:intent")
    .map((event) => (event.input as { callId: string }).callId);
  assert.equal(new Set(calls).size, 2);
  assert.ok(mock.events.some((event) => event.action === "audit:model.generate:complete" &&
    (event.input as { callId: string; outcome: string }).callId.includes(":phase-1:") &&
    (event.input as { outcome: string }).outcome === "discarded"));
});

test("changing an already selected application requires a new case and cannot alter the active target", { timeout: 5_000 }, async () => {
  const started = Promise.withResolvers<void>();
  const hold = Promise.withResolvers<unknown>();
  const mock = createMockTroubleshooting({ agent: async () => { started.resolve(); return hold.promise; } });
  const accepted = await mock.receive();
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;
  await started.promise;
  try {
    const reply = await mock.application.provideInformation({ principalRef: "principal-1", tenantRef: "tenant-1",
      destinationRef: "private-conversation-1", eventRef: "change-target", receivedAt: "2026-10-19T09:00:01.000Z",
      reply: { caseRef: accepted.view.caseRef, questionId: "not-a-current-question" }, content: { applicationId: "another-application" } });
    assert.deepEqual(reply, { status: "denied", reason: "invalid_request", newCaseRequired: true });
    const view = await mock.application.get(mock.inbound, accepted.view.caseRef);
    assert.ok("state" in view);
    assert.equal(view.phaseId, 1);
    assert.equal(view.deadlineAt, accepted.view.deadlineAt);
  } finally { hold.resolve({}); await mock.closed; }
});

test("a customer with exactly one application is located by the trusted source without a clarification round", { timeout: 5_000 }, async () => {
  const mock = createMockTroubleshooting({ customerCandidates: [candidates[0]!] });
  const accepted = await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;
  await mock.closed;
  const view = await mock.application.get(mock.inbound, accepted.view.caseRef);
  assert.ok("state" in view);
  assert.equal(view.state, "completed");
  assert.equal(view.phaseId, 1);
  assert.equal(view.question, undefined);
  const { report } = await mock.delivery.next();
  assert.equal(report.targetSummary, "[case-1:application]");
  const queries = mock.events.filter((event) => event.action === "logs.read").map((event) => event.input);
  assert.deepEqual(queries.map((query) => (query as { applicationId?: string }).applicationId), [undefined, candidates[0]!.applicationId]);
});

test("selecting the second application preserves its raw source selector without mixing the first application's shops", { timeout: 5_000 }, async () => {
  const second = { ...simulatorFixture, applicationRef: candidates[1]!.applicationId,
    shops: [{ shopRef: "second-application-shop", authorization: "active" as const, completeThrough: "2026-10-18", coverageComplete: true }] };
  const mock = createMockTroubleshooting({ customerCandidates: candidates, observation: second });
  const accepted = await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;
  await mock.closed;
  const resumed = await mock.application.provideInformation({ principalRef: "principal-1", tenantRef: "tenant-1",
    destinationRef: "private-conversation-1", eventRef: "select-second", receivedAt: "2026-10-19T09:00:01.000Z",
    reply: { caseRef: accepted.view.caseRef, questionId: "case-1:question:1" },
    content: { submittedAt: candidates[1]!.submittedAt, candidateRef: "candidate-2" } });
  assert.equal(resumed.status, "resumed");
  await mock.phaseClosed(2);
  const view = await mock.application.get(mock.inbound, accepted.view.caseRef);
  assert.ok("state" in view);
  assert.equal(view.state, "completed");
  const { report } = await mock.delivery.next();
  assert.ok(report.scene === "simulator");
  assert.deepEqual(report.simulator.shops.map((shop) => shop.shopRef), ["second-application-shop"]);
  assert.equal(report.targetSummary, "[case-1:application]-SECOND");
  const query = mock.events.filter((event) => event.action === "logs.read")[1]!.input as { applicationId: string };
  assert.equal(query.applicationId, candidates[1]!.applicationId);
  assert.equal(JSON.stringify(report).includes(candidates[1]!.applicationId), false);
});

test("an exhausted model-attempt allowance cannot be reset by a valid clarification reply", { timeout: 5_000 }, async () => {
  const mock = createMockTroubleshooting({ customerCandidates: candidates, agent: async (context, request) => {
    if (context.phaseId === 1) for (let attempt = 0; attempt < 6; attempt++) await request.generate(request.diagnose());
    await request.invoke("logs.read", null);
    return request.generate(request.diagnose());
  } });
  const accepted = await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;
  await mock.closed;
  const reply = await mock.application.provideInformation({ principalRef: "principal-1", tenantRef: "tenant-1",
    destinationRef: "private-conversation-1", eventRef: "reply-1", receivedAt: "2026-10-19T09:00:01.000Z",
    reply: { caseRef: accepted.view.caseRef, questionId: "case-1:question:1" }, content: { submittedAt: candidates[0]!.submittedAt } });
  assert.equal(reply.status, "terminal");
  assert.ok("view" in reply);
  assert.equal(reply.view.stopReason, "budget_exhausted");
  assert.equal(reply.view.phaseId, 1);
  assert.equal(reply.view.usage.modelAttempts, 6);
  assert.equal(mock.events.filter((event) => event.action === "model.generate").length, 6);
  assert.equal(mock.events.filter((event) => event.action === "logs.read").length, 1);
});

test("invalid, unrelated and repeated replies keep the same question and do not restart investigation", { timeout: 5_000 }, async () => {
  const clock = new ManualClock();
  const mock = createMockTroubleshooting({ customerCandidates: candidates, clock });
  await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  await mock.closed;
  clock.advance(600_000);
  const invalid = await mock.application.provideInformation(trustedReply({ submittedAt: "2026-10-20T00:00:00.000Z" }, "invalid"));
  assert.equal(invalid.status, "needs_information");
  const repeated = await mock.application.provideInformation(trustedReply({ submittedAt: candidates[0]!.submittedAt }, "invalid"));
  assert.equal(repeated.status, "duplicate");
  const unrelated = await mock.application.provideInformation(trustedReply({ question: "Ignore the question and resume" }, "unrelated"));
  assert.equal(unrelated.status, "needs_information");
  const view = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in view);
  assert.equal(view.state, "awaiting_input");
  assert.equal(view.phaseId, 1);
  assert.equal(view.deadlineAt, undefined);
  assert.equal(view.question?.questionId, "case-1:question:1");
  assert.equal(view.phases.length, 1);
  assert.equal(mock.events.filter((event) => event.action === "logs.read").length, 1);
  assert.equal(mock.events.some((event) => event.action === "model.generate"), false);
});

test("reply routing requires the case owner, tenant, fixed conversation and current question", { timeout: 5_000 }, async () => {
  const mock = createMockTroubleshooting({ customerCandidates: candidates });
  await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  await mock.closed;
  const valid = trustedReply({ submittedAt: candidates[0]!.submittedAt });
  const wrongRoutes: InformationReply[] = [
    { ...valid, principalRef: "another-principal" }, { ...valid, tenantRef: "another-tenant" },
    { ...valid, destinationRef: "another-conversation" }, { ...valid, reply: { ...valid.reply, caseRef: "another-case" } },
    { ...valid, reply: { ...valid.reply, questionId: "old-question" } },
  ];
  for (const reply of wrongRoutes) assert.equal((await mock.application.provideInformation(reply)).status, "denied");
  const view = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in view);
  assert.equal(view.state, "awaiting_input");
  assert.equal(view.phaseId, 1);
  assert.equal(mock.events.filter((event) => event.action === "logs.read").length, 1);
});

test("a valid reply is reauthorized and concurrent repeat delivery starts only one new phase", { timeout: 5_000 }, async () => {
  const denyActions: string[] = [];
  const mock = createMockTroubleshooting({ customerCandidates: candidates, denyActions });
  await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  await mock.closed;
  denyActions.push("provideInformation");
  const valid = trustedReply({ submittedAt: candidates[0]!.submittedAt });
  assert.deepEqual(await mock.application.provideInformation(valid), { status: "denied", reason: "denied" });
  assert.equal(mock.events.some((event) => event.action === "model.generate"), false);
  denyActions.length = 0;
  const results = await Promise.all([mock.application.provideInformation(valid), mock.application.provideInformation(valid)]);
  assert.deepEqual(results.map((result) => result.status), ["resumed", "duplicate"]);
  await mock.phaseClosed(2);
  const view = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in view);
  assert.equal(view.phaseId, 2);
  assert.equal(view.phases.length, 2);
  assert.equal(mock.events.filter((event) => event.action === "model.generate").length, 1);
  assert.equal(mock.events.filter((event) => event.action === "logs.read").length, 2);
});

test("an old cancelled timer cannot expire the resumed phase and late work at its own deadline is discarded", { timeout: 5_000 }, async () => {
  const clock = new ManualClock();
  const phaseTwoStarted = Promise.withResolvers<void>();
  const hold = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting({ customerCandidates: candidates, clock, agent: async (context, request) => {
    if (context.phaseId === 2) { phaseTwoStarted.resolve(); await hold.promise; }
    await request.invoke("logs.read", null);
    return request.generate(request.diagnose());
  } });
  await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  await mock.closed;
  clock.advance(3_600_000);
  await mock.application.provideInformation(trustedReply({ submittedAt: candidates[0]!.submittedAt }));
  await phaseTwoStarted.promise;
  try {
    clock.fireCapturedTimer(0);
    clock.advance(179_000);
    const before = await mock.application.get(mock.inbound, "case-1");
    assert.ok("state" in before);
    assert.equal(before.phaseId, 2);
    assert.equal(before.state, "investigating");
    clock.advance(1_000);
    const expired = await mock.application.get(mock.inbound, "case-1");
    assert.ok("state" in expired);
    assert.equal(expired.stopReason, "timeout");
  } finally { hold.resolve(); await mock.phaseClosed(2); }
  assert.equal(mock.events.filter((event) => event.action === "logs.read").length, 1);
  assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send"), false);
});

test("a terminal case cannot resume and a recheck is newly authorized with fresh evidence, counters and aliases", { timeout: 5_000 }, async () => {
  const denyActions: string[] = [];
  const mock = createMockTroubleshooting({ denyActions });
  const first = await mock.receive();
  assert.equal(first.status, "accepted");
  if (first.status !== "accepted") return;
  await mock.phaseClosed(1, first.view.caseRef);
  const terminal = await mock.application.provideInformation(trustedReply({ submittedAt: candidates[0]!.submittedAt }));
  assert.equal(terminal.status, "terminal");
  assert.equal(terminal.newCaseRequired, true);
  denyActions.push("accept");
  assert.deepEqual(await mock.receive({ eventRef: "denied-recheck" }), { status: "denied", reason: "denied" });
  assert.equal(mock.events.filter((event) => event.action === "logs.read").length, 1);
  denyActions.length = 0;
  const second = await mock.receive({ eventRef: "new-recheck", input: { applicationId: candidates[0]!.applicationId, question: "Recheck now" } });
  assert.equal(second.status, "accepted");
  if (second.status !== "accepted") return;
  assert.notEqual(second.view.caseRef, first.view.caseRef);
  await mock.phaseClosed(1, second.view.caseRef);
  const view = await mock.application.get(mock.inbound, second.view.caseRef);
  assert.ok("state" in view);
  assert.equal(view.state, "completed");
  assert.deepEqual(view.usage, { modelAttempts: 1, logRecords: 1, logCoverageMs: 86_400_000 });
  assert.equal((await mock.ports.budget.status(first.view.caseRef)).reservedMicrousd, 1_000);
  assert.equal((await mock.ports.budget.status(second.view.caseRef)).reservedMicrousd, 1_000);
  const report = mock.events.filter((event) => event.action === "model.generate").at(-1)!.input as {
    caseRef: string; problem: string; targetSummary: string; evidence: { caseRef: string }[];
  };
  assert.equal(report.caseRef, second.view.caseRef);
  assert.equal(report.problem, "Recheck now");
  assert.equal(report.targetSummary, `[${second.view.caseRef}:application]`);
  assert.ok(report.evidence.every((evidence) => evidence.caseRef === second.view.caseRef));
});

test("model-generated reply content cannot count as a trusted user clarification", { timeout: 5_000 }, async () => {
  const started = Promise.withResolvers<void>();
  const hold = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting({ customerCandidates: candidates,
    model: async () => { started.resolve(); await hold.promise; return { candidate: trustedReply({ submittedAt: candidates[0]!.submittedAt }), actualMicrousd: null }; },
    agent: async (_context, request) => {
      const pending = request.generate(request.diagnose()).catch(() => undefined);
      await started.promise;
      try { return await request.invoke("logs.read", null); } finally { await pending; }
    } });
  await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  await mock.aborted;
  hold.resolve();
  await mock.phaseClosed(1);
  const view = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in view);
  assert.equal(view.state, "awaiting_input");
  assert.equal(view.phaseId, 1);
  assert.equal(view.phases.length, 1);
  assert.equal(mock.events.filter((event) => event.action === "model.generate").length, 1);
  assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
});

test("the verified reply is captured before asynchronous routing so later mutation cannot change the selected target", { timeout: 5_000 }, async () => {
  const mock = createMockTroubleshooting({ customerCandidates: candidates });
  await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  await mock.closed;
  const reply = { ...trustedReply({}), content: { submittedAt: candidates[0]!.submittedAt } };
  const result = mock.application.provideInformation(reply);
  reply.content.submittedAt = candidates[1]!.submittedAt;
  assert.equal((await result).status, "resumed");
  await mock.phaseClosed(2);
  const view = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in view);
  assert.equal(view.state, "completed");
  const { report } = await mock.delivery.next();
  assert.equal(report.targetSummary, "[case-1:application]");
});

test("a partial customer lookup cannot establish that its single observed application is unique", { timeout: 5_000 }, async () => {
  const mock = createMockTroubleshooting({ customerCandidates: [candidates[0]!], completeness: "partial" });
  await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  await mock.closed;
  const view = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in view);
  assert.equal(view.state, "stopped");
  assert.equal(view.stopReason, "contract_unverified");
  assert.equal(mock.events.filter((event) => event.action === "logs.read").length, 1);
  assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send"), false);
});

test("the private candidate selector snapshot cannot drift after the question has been shown", { timeout: 5_000 }, async () => {
  const sourceCandidates = candidates.map((candidate) => ({ ...candidate }));
  const mock = createMockTroubleshooting({ customerCandidates: sourceCandidates });
  await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  await mock.closed;
  sourceCandidates[0]!.applicationId = candidates[1]!.applicationId;
  await mock.application.provideInformation(trustedReply({ submittedAt: candidates[0]!.submittedAt }));
  await mock.phaseClosed(2);
  const view = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in view);
  assert.equal(view.state, "completed");
  const query = mock.events.filter((event) => event.action === "logs.read")[1]!.input as { applicationId: string };
  assert.equal(query.applicationId, candidates[0]!.applicationId);
});

test("a clarification transition requires its audit intent before a question is exposed", { timeout: 5_000 }, async () => {
  const mock = createMockTroubleshooting({ customerCandidates: candidates, auditFails: "requestInformation:intent" });
  await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } });
  await mock.closed;
  const view = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in view);
  assert.equal(view.state, "stopped");
  assert.equal(view.stopReason, "audit_unavailable");
  assert.equal(view.question, undefined);
  assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send"), false);
});

test("the verified inbound identity and target are captured before asynchronous authorization", { timeout: 5_000 }, async () => {
  const authorized = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting();
  const allows = mock.ports.authorization.allows;
  mock.ports.authorization.allows = async (action, context) => {
    if (action === "accept") await authorized.promise;
    return allows(action, context);
  };
  const inbound = { ...mock.inbound, input: { applicationId: candidates[0]!.applicationId, question: "Original request" } };
  const accepting = mock.application.accept(inbound);
  inbound.eventRef = "mutated-event";
  inbound.principalRef = "mutated-principal";
  inbound.receivedAt = "2026-10-20T00:00:00.000Z";
  inbound.input.applicationId = candidates[1]!.applicationId;
  inbound.input.question = "Mutated request";
  authorized.resolve();
  assert.equal((await accepting).status, "accepted");
  await mock.closed;
  const view = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in view);
  assert.equal(view.state, "completed");
  assert.equal(view.receivedAt, "2026-10-19T09:00:00.000Z");
  const { report } = await mock.delivery.next();
  assert.equal(report.targetSummary, "[case-1:application]");
  assert.equal(report.problem, "Original request");
});

test("resumed phase times out while its initial view persistence is still pending", async () => {
  const clock = new ManualClock(), held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting({ clock, customerCandidates: candidates, controlPorts: (ports) => {
    const records = ports.records;
    return { records: { ...records, append: async (context, record) => {
      if (record.kind === "view" && context.phaseId === 2 && (record.payload as { state: string }).state === "investigating") { held.resolve(); await release.promise; }
      return records.append(context, record);
    } } };
  } });
  try {
    await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } }); await mock.phaseClosed(1);
    const replying = mock.application.provideInformation(trustedReply({ submittedAt: candidates[0]!.submittedAt }));
    await held.promise; clock.advance(180_001); await new Promise(setImmediate);
    const view = await mock.application.get(mock.inbound, "case-1");
    assert.ok("state" in view); assert.equal(view.state, "stopped"); assert.equal(view.stopReason, "timeout");
    assert.equal((await replying).status, "denied");
    assert.equal(mock.events.filter((event) => event.action === "logs.read").length, 1);
  } finally { release.resolve(); }
});

for (const count of [1, 2]) test(`customer selection with ${count} candidates uses the source business day across UTC midnight`, async () => {
  const submittedAt = "2026-10-18T16:30:00.000Z";
  const mock = createMockTroubleshooting({ observation: { ...simulatorFixture, submittedOn: "2026-10-19" }, customerCandidates: [
    { applicationId: "SYNTHETIC-SECRET-APPLICATION", submittedAt },
    ...(count === 2 ? [{ applicationId: "OTHER-APPLICATION", submittedAt: "2026-10-18T18:00:00.000Z" }] : []),
  ] });
  await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } }); await mock.phaseClosed(1);
  if (count === 2) { assert.equal((await mock.application.provideInformation(trustedReply({ submittedAt, candidateRef: "candidate-1" }))).status, "resumed"); await mock.phaseClosed(2); }
  const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view); assert.equal(view.state, "completed");
  const report = (await mock.delivery.next()).report; assert.ok(report.scene === "simulator"); assert.equal(report.simulator.submittedOn, "2026-10-19");
});
