import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { Troubleshooting } from "../../src/troubleshooting/application/troubleshooting.js";
import { ManualClock } from "../fixtures/clock.js";
import { pspFixture } from "../fixtures/psp.js";

test("a PSP investigation with no observations preserves unknown applicability and cannot borrow Simulator shop readiness", async () => {
  const mock = createMockTroubleshooting({ pspObservation: null });
  const accepted = await mock.receive({ input: { scenario: "psp", applicationId: "SYNTHETIC-SECRET-APPLICATION",
    shopId: "SYNTHETIC-SECRET-SHOP", bindingId: "SYNTHETIC-SECRET-BINDING", question: "Why is this shop uncontrolled?" } });
  assert.equal(accepted.status, "accepted"); await mock.closed;
  const delivered = await mock.delivery.next();
  const report = delivered.report;
  assert.ok(report.scene === "psp"); assert.equal("simulator" in report, false);
  assert.equal(report.psp.support.status, "unknown"); assert.equal(report.psp.prerequisite, "unknown");
  assert.equal(report.psp.approval, "unknown"); assert.equal(report.psp.amount, null);
  assert.doesNotMatch(JSON.stringify(delivered), /SYNTHETIC-SECRET|all submitted shops|10 submitted shops/);
});

test("an independently evidenced unsupported combination reports second-step not applicable rather than executed passed", async () => {
  const mock = createMockTroubleshooting({ pspObservation: pspFixture });
  await mock.receive({ input: { scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef,
    bindingId: pspFixture.target.bindingRef, question: "Explain this PSP verification." } });
  await mock.closed;
  const report = (await mock.delivery.next()).report;
  assert.ok(report.scene === "psp");
  assert.equal(report.psp.first.status, "passed"); assert.equal(report.psp.support.status, "unsupported");
  assert.equal(report.psp.support.basis, "synthetic-combination-register"); assert.equal(report.psp.support.version, "synthetic-capabilities-1");
  assert.equal(report.psp.support.effectiveAt, "2026-10-01T00:00:00.000Z");
  assert.equal(report.psp.second.status, "not_applicable"); assert.equal(report.psp.prerequisite, "met");
  assert.ok(report.facts.every((fact) => fact.evidenceRefs.every((ref) => report.evidence.some((item) => item.evidenceRef === ref))));
});

test("one observed passed shop linked to the same customer satisfies the PSP prerequisite while target and other shops stay unknown or uncontrolled", async () => {
  const observation = { ...pspFixture, final: { ...pspFixture.final, status: "uncontrolled" as const }, linkedShops: [
    { applicationRef: pspFixture.applicationRef, customerRef: pspFixture.customerRef, shopRef: "other-passed-shop", bindingRef: "other-binding",
      status: "passed" as const, eventRef: "other-shop-passed", observedAt: "2026-10-18T12:01:00.000Z" },
    { applicationRef: pspFixture.applicationRef, customerRef: pspFixture.customerRef, shopRef: "unknown-shop", bindingRef: "unknown-binding",
      status: "unknown" as const, eventRef: null, observedAt: null },
  ] };
  const mock = createMockTroubleshooting({ pspObservation: observation, completeness: "unknown" });
  await mock.receive({ input: { scenario: "psp", applicationId: observation.applicationRef, shopId: observation.target.shopRef,
    bindingId: observation.target.bindingRef, question: "Explain the target shop and PSP prerequisite." } }); await mock.closed;
  const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view); assert.equal(view.state, "completed");
  const report = (await mock.delivery.next()).report; assert.ok(report.scene === "psp");
  assert.equal(report.psp.final.status, "uncontrolled"); assert.equal(report.psp.prerequisite, "met");
  assert.equal(report.psp.approval, "unknown"); assert.equal(report.psp.amount, null);
  assert.ok(report.facts.some((fact) => fact.statement.includes("other-passed-shop") && fact.evidenceRefs.length > 0));
  assert.match(report.limitations.join(" "), /unknown|every customer shop/);
});

test("the model can select only the current full host PSP draft without echoing its evidence inside the bounded output", async () => {
  const mock = createMockTroubleshooting({ pspObservation: pspFixture, candidate: (draft) => {
    assert.ok(draft.scene === "psp"); return { reportRef: draft.reportRef, draftVersion: draft.draftVersion };
  } });
  await mock.receive({ input: { scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef,
    bindingId: pspFixture.target.bindingRef, question: "Explain PSP verification." } }); await mock.closed;
  const saved = await mock.ports.records.read(mock.inbound, "case-1"); assert.ok(saved?.scope === "full");
  assert.equal(saved.view.state, "completed");
  const delivered = (await mock.delivery.next()).report; assert.ok(delivered.scene === "psp");
  assert.ok(delivered.evidence.length >= 4); assert.equal(delivered.psp.support.status, "unsupported");
  const input = saved.records.find((record) => record.kind === "model_input")!.payload as { canonicalInput: string };
  assert.match(input.canonicalInput, /synthetic-capabilities-1/);
  const output = saved.records.find((record) => record.kind === "model_output")!.payload as { candidate: unknown };
  assert.deepEqual(output.candidate, { reportRef: delivered.reportRef, draftVersion: delivered.draftVersion });
  assert.ok(Buffer.byteLength(JSON.stringify(output.candidate)) < 200);
});

for (const invalid of ["extra", "foreign", "wrong-phase", "wrong-material"] as const) test(`a ${invalid} PSP selection cannot authorize a report`, async () => {
  const mock = createMockTroubleshooting({ pspObservation: pspFixture, candidate: (draft) => {
    assert.ok(draft.scene === "psp");
    return { reportRef: invalid === "foreign" ? "another-case:report:1" : draft.reportRef,
      draftVersion: invalid === "wrong-phase" ? draft.draftVersion.replace(":phase-1:", ":phase-0:")
        : invalid === "wrong-material" ? draft.draftVersion.replace(/material-\d+$/, "material-0") : draft.draftVersion,
      ...(invalid === "extra" ? { facts: [] } : {}) };
  } });
  await mock.receive({ input: { scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef,
    bindingId: pspFixture.target.bindingRef, question: "Explain PSP verification." } }); await mock.closed;
  const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view);
  assert.equal(view.state, "stopped"); assert.equal(view.stopReason, "unsafe_content");
  assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
});

test("a draft selected before later accepted evidence is stale even within the same phase", async () => {
  const mock = createMockTroubleshooting({ pspObservation: pspFixture,
    candidate: (draft) => { assert.ok(draft.scene === "psp"); return { reportRef: draft.reportRef, draftVersion: draft.draftVersion }; },
    agent: async (_context, request) => {
      const old = request.diagnose(); await request.invoke("logs.read", null); await request.invoke("code.search", null); return request.generate(old);
    } });
  await mock.receive({ input: { scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef,
    bindingId: pspFixture.target.bindingRef, question: "Explain PSP verification." } }); await mock.closed;
  const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view);
  assert.equal(view.stopReason, "unsafe_content"); assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
});

test("an applicable transaction pass and tail-three failure remain separately evidenced without a fabricated approval or amount", async () => {
  const observation = { ...pspFixture, support: { ...pspFixture.support, status: "supported" as const },
    second: { transaction: { status: "passed" as const, eventRef: "transaction-pass", observedAt: "2026-10-18T12:00:02.000Z" },
      tailThree: { status: "failed" as const, eventRef: "tail-three-failure", observedAt: "2026-10-18T12:00:03.000Z" } },
    final: { ...pspFixture.final, status: "uncontrolled" as const, observedAt: "2026-10-18T12:00:04.000Z" } };
  const mock = createMockTroubleshooting({ pspObservation: observation });
  await mock.receive({ input: { scenario: "psp", applicationId: observation.applicationRef, shopId: observation.target.shopRef,
    bindingId: observation.target.bindingRef, question: "Explain both verification steps." } }); await mock.closed;
  const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view); assert.equal(view.state, "completed");
  const report = (await mock.delivery.next()).report; assert.ok(report.scene === "psp");
  assert.equal(report.psp.second.transaction.status, "passed"); assert.equal(report.psp.second.tailThree.status, "failed");
  assert.notDeepEqual(report.psp.second.transaction.evidenceRefs, report.psp.second.tailThree.evidenceRefs);
  assert.equal(report.psp.final.status, "uncontrolled"); assert.equal(report.psp.prerequisite, "unknown");
  assert.equal(report.psp.approval, "unknown"); assert.equal(report.psp.amount, null);
});

test("a complete larger PSP host draft stays in input and records while its model selection obeys the unchanged output bound", async () => {
  const mock = createMockTroubleshooting({ pspObservation: pspFixture });
  const search = mock.ports.code.search;
  mock.ports.code.search = async (context, query) => { const read = await search(context, query); return { ...read,
    evidence: read.evidence.map((item) => ({ ...item, text: "Synthetic frozen PSP code reference: " + "a".repeat(4_000) })) }; };
  await mock.receive({ input: { scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef,
    bindingId: pspFixture.target.bindingRef, question: "Explain PSP verification." } }); await mock.closed;
  const saved = await mock.ports.records.read(mock.inbound, "case-1"); assert.ok(saved?.scope === "full"); assert.equal(saved.view.state, "completed");
  const report = (await mock.delivery.next()).report; assert.ok(report.scene === "psp");
  assert.ok(Buffer.byteLength(JSON.stringify(report)) > 8_192);
  assert.equal(report.evidence.find((item) => item.kind === "code")!.text.length, 4_037);
  const output = saved.records.find((record) => record.kind === "model_output")!.payload as { candidate: unknown };
  assert.deepEqual(output.candidate, { reportRef: report.reportRef, draftVersion: report.draftVersion });
  const input = saved.records.find((record) => record.kind === "model_input")!.payload as { canonicalInput: string; inputTokensUpperBound: number; maxOutputTokens: number };
  assert.ok(input.canonicalInput.includes("a".repeat(4_000))); assert.ok(input.inputTokensUpperBound <= 24_000); assert.equal(input.maxOutputTokens, 4_000);
});

test("two fixed log aliases do not consume a fourth repository slot in the immutable shared case scope", async () => {
  const resources = ["simulator-source", "psp-log-source", "psp-code", "shared-code"];
  const mock = createMockTroubleshooting({ pspObservation: null, resourceRefs: resources });
  const accepted = await mock.receive({ input: { scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef,
    bindingId: pspFixture.target.bindingRef, question: "Explain PSP verification." } });
  assert.equal(accepted.status, "accepted"); await mock.closed;
  const saved = await mock.ports.records.read(mock.inbound, "case-1"); assert.ok(saved?.scope === "full");
  const toolAudits = saved.audits.filter((entry) => ["logs.read", "code.search"].includes(String(entry.action)));
  assert.ok(toolAudits.length >= 2); assert.ok(toolAudits.every((entry) => JSON.stringify(entry.resourceRefs) === JSON.stringify(resources)));
});

test("a trusted PSP binding selection resumes the same case and cannot change a supplied target", async () => {
  const mock = createMockTroubleshooting({ pspObservation: pspFixture });
  const read = mock.ports.logs.read;
  mock.ports.logs.read = async (context, query) => {
    const result = await read(context, query);
    if (query.bindingId) return result;
    return { ...result, value: { kind: "psp_target_candidates", candidates: [
      { applicationId: pspFixture.applicationRef, customerId: pspFixture.customerRef, shopId: pspFixture.target.shopRef,
        bindingId: "old-synthetic-binding", boundAt: "2026-10-17T10:00:00.000Z" },
      { applicationId: pspFixture.applicationRef, customerId: pspFixture.customerRef, shopId: pspFixture.target.shopRef,
        bindingId: pspFixture.target.bindingRef, boundAt: pspFixture.target.boundAt },
    ] } };
  };
  await mock.receive({ input: { scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef,
    question: "Which binding explains this shop?" } }); await mock.phaseClosed(1);
  const waiting = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in waiting);
  assert.equal(waiting.state, "awaiting_input"); assert.deepEqual(waiting.question?.requiredFields, ["candidateRef"]);
  assert.equal(mock.events.some((event) => event.action === "model.generate"), false);
  const reply = { ...mock.inbound, eventRef: "psp-reply", reply: { caseRef: "case-1", questionId: waiting.question!.questionId }, content: { candidateRef: "candidate-2" } };
  const changed = await mock.application.provideInformation({ ...reply, eventRef: "changed-target", content: { candidateRef: "candidate-2", shopId: "another-shop" } });
  assert.deepEqual(changed, { status: "denied", reason: "invalid_request", newCaseRequired: true });
  assert.equal((await mock.application.provideInformation(reply)).status, "resumed"); await mock.phaseClosed(2);
  const report = (await mock.delivery.next()).report; assert.ok(report.scene === "psp");
  assert.equal(report.psp.target?.boundAt, pspFixture.target.boundAt); assert.match(report.draftVersion, /:phase-2:/);
  assert.equal((await mock.application.provideInformation(reply)).status, "duplicate");
  const queries = mock.events.filter((event) => event.action === "logs.read").map((event) => event.input as { sourceRef: string; bindingId?: string });
  assert.equal(queries.at(-1)!.sourceRef, "psp-log-source"); assert.equal(queries.at(-1)!.bindingId, pspFixture.target.bindingRef);
});


test("a host enabling both scenarios retains Simulator source and all-submitted-shop readiness", async () => {
  const mock = createMockTroubleshooting({ pspObservation: pspFixture });
  await mock.receive(); await mock.closed;
  const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view); assert.equal(view.state, "completed");
  const report = (await mock.delivery.next()).report; assert.ok(report.scene === "simulator");
  assert.equal(report.simulator.shopCount, 10); assert.equal(report.simulator.dataReadiness.satisfied, 9);
  assert.ok(report.evidence.every((item) => item.sourceRef === "simulator-source"));
});

test("a concrete PSP timeout branch requires correlated execution and the exact frozen code commit", async () => {
  const observation = { ...pspFixture, final: { ...pspFixture.final, status: "uncontrolled" as const },
    executions: [{ stage: "first" as const, outcome: "timeout" as const, ruleRef: "synthetic-first-timeout", codeCommit: "1".repeat(40),
      eventRef: "first-timeout-executed", observedAt: "2026-10-18T12:00:01.000Z" }] };
  const mock = createMockTroubleshooting({ pspObservation: observation });
  const search = mock.ports.code.search;
  mock.ports.code.search = async (context, query) => { const result = await search(context, query); return { ...result,
    evidence: result.evidence.map((item) => ({ ...item, code: { ...item.code!, pspRule: { ruleRef: "synthetic-first-timeout", stage: "first", outcome: "timeout", prerequisite: "one_passed_shop" } as const } })) }; };
  await mock.receive({ input: { scenario: "psp", applicationId: observation.applicationRef, shopId: observation.target.shopRef,
    bindingId: observation.target.bindingRef, question: "Did the timeout branch execute?" } }); await mock.closed;
  const report = (await mock.delivery.next()).report; assert.ok(report.scene === "psp");
  assert.equal(report.psp.branches.length, 1); assert.equal(report.psp.branches[0]!.outcome, "timeout");
  assert.ok(report.psp.branches[0]!.evidenceRefs.some((ref) => report.evidence.find((item) => item.evidenceRef === ref)?.kind === "code"));
  assert.ok(report.psp.branches[0]!.evidenceRefs.some((ref) => report.evidence.find((item) => item.evidenceRef === ref)?.kind === "log"));
});

for (const outcome of ["waiting", "missing", "failed", "timeout", "fallback"] as const) test(`the ${outcome} branch is unknown when frozen code and execution do not correlate`, async () => {
  const observation = { ...pspFixture, executions: [{ stage: "first" as const, outcome, ruleRef: "synthetic-branch", codeCommit: "2".repeat(40), eventRef: "branch-event", observedAt: "2026-10-18T12:00:01.000Z" }] };
  const mock = createMockTroubleshooting({ pspObservation: observation });
  const search = mock.ports.code.search;
  mock.ports.code.search = async (context, query) => { const result = await search(context, query); return { ...result,
    evidence: result.evidence.map((item) => ({ ...item, code: { ...item.code!, pspRule: { ruleRef: "synthetic-branch", stage: "first", outcome, prerequisite: "one_passed_shop" } as const } })) }; };
  await mock.receive({ input: { scenario: "psp", applicationId: observation.applicationRef, shopId: observation.target.shopRef,
    bindingId: observation.target.bindingRef, question: "Was that branch executed?" } }); await mock.closed;
  const report = (await mock.delivery.next()).report; assert.ok(report.scene === "psp");
  assert.deepEqual(report.psp.branches, []); assert.match(report.limitations.join(" "), /lacks matching frozen code/);
});

test("conflicting code policy is shown separately without changing the one-passed-shop business prerequisite", async () => {
  const mock = createMockTroubleshooting({ pspObservation: pspFixture });
  const search = mock.ports.code.search;
  mock.ports.code.search = async (context, query) => { const result = await search(context, query); return { ...result,
    evidence: result.evidence.map((item) => ({ ...item, code: { ...item.code!, pspRule: { ruleRef: "synthetic-all-shops", stage: "first", outcome: "waiting", prerequisite: "all_shops_passed" } as const } })) }; };
  await mock.receive({ input: { scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef,
    bindingId: pspFixture.target.bindingRef, question: "Does all-shops code agree with business policy?" } }); await mock.closed;
  const report = (await mock.delivery.next()).report; assert.ok(report.scene === "psp");
  assert.equal(report.psp.prerequisite, "met"); assert.equal(report.psp.conflicts.length, 1);
  assert.match(report.psp.conflicts[0]!.statement, /all shops.*one passed shop/);
  assert.match(report.humanNextSteps.join(" "), /conflict/); assert.equal(report.psp.approval, "unknown"); assert.equal(report.psp.amount, null);
});

test("unknown scenario and Simulator-only input cannot install PSP selectors", async () => {
  for (const input of [ { scenario: "invented", applicationId: pspFixture.applicationRef, question: "Why?" },
    { applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef, question: "Why?" } ]) {
    const mock = createMockTroubleshooting({ pspObservation: pspFixture });
    assert.deepEqual(await mock.receive({ input: input as never }), { status: "denied", reason: "invalid_request" });
    assert.equal(mock.events.some((event) => ["logs.read", "model.generate"].includes(event.action)), false);
  }
});

test("a later source read cannot replace the customer's already fixed shop and PSP business record", async () => {
  const mock = createMockTroubleshooting({ pspObservation: pspFixture, agent: async (_context, request) => {
    await request.invoke("logs.read", null); await request.invoke("logs.read", null); return request.generate(request.diagnose());
  } });
  const read = mock.ports.logs.read; let calls = 0;
  mock.ports.logs.read = async (context, query) => { const result = await read(context, query); calls++;
    return calls === 2 ? { ...result, value: { ...pspFixture, customerRef: "another-customer" } } : result; };
  await mock.receive({ input: { scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef,
    bindingId: pspFixture.target.bindingRef, question: "Keep the same binding." } }); await mock.closed;
  const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view); assert.equal(view.state, "stopped"); assert.equal(view.stopReason, "invalid_request");
  assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send"), false);
});

test("conflicting current linked-shop outcomes do not establish a customer prerequisite", async () => {
  const observation = { ...pspFixture, final: { ...pspFixture.final, status: "uncontrolled" as const }, linkedShops: [
    { applicationRef: pspFixture.applicationRef, customerRef: pspFixture.customerRef, shopRef: "other-shop", bindingRef: "other-binding", status: "passed" as const,
      eventRef: "other-pass", observedAt: "2026-10-18T12:00:04.000Z" },
    { applicationRef: pspFixture.applicationRef, customerRef: pspFixture.customerRef, shopRef: "other-shop", bindingRef: "other-binding", status: "not_passed" as const,
      eventRef: "other-fail", observedAt: "2026-10-18T12:00:04.000Z" },
  ] };
  const mock = createMockTroubleshooting({ pspObservation: observation });
  await mock.receive({ input: { scenario: "psp", applicationId: observation.applicationRef, shopId: observation.target.shopRef,
    bindingId: observation.target.bindingRef, question: "What is known about the prerequisite?" } }); await mock.closed;
  const report = (await mock.delivery.next()).report; assert.ok(report.scene === "psp");
  assert.equal(report.psp.prerequisite, "unknown"); assert.ok(report.psp.conflicts.length > 0); assert.match(report.psp.conflicts[0]!.statement, /Conflicting/);
});

test("a uniquely located PSP target keeps the customer linkage from its trusted discovery", async () => {
  const mock = createMockTroubleshooting({ pspObservation: { ...pspFixture, customerRef: "foreign-customer" } });
  const read = mock.ports.logs.read;
  mock.ports.logs.read = async (context, query) => { const result = await read(context, query); return query.bindingId ? result : { ...result,
    value: { kind: "psp_target_candidates", candidates: [{ applicationId: pspFixture.applicationRef, customerId: pspFixture.customerRef,
      shopId: pspFixture.target.shopRef, bindingId: pspFixture.target.bindingRef, boundAt: pspFixture.target.boundAt }] } }; };
  await mock.receive({ input: { scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef, question: "Resolve this binding." } }); await mock.closed;
  const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view); assert.equal(view.state, "stopped"); assert.equal(view.stopReason, "invalid_request");
  assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send"), false);
});

test("PSP clarification cannot relabel another target's discovery evidence", async () => {
  const mock = createMockTroubleshooting({ pspObservation: pspFixture }); const read = mock.ports.logs.read;
  mock.ports.logs.read = async (context, query) => { const result = await read(context, query); return { ...result,
    evidence: result.evidence.map((item) => ({ ...item, targetRef: "another-application" })),
    value: { kind: "psp_target_candidates", candidates: [{ applicationId: pspFixture.applicationRef, customerId: pspFixture.customerRef,
      shopId: pspFixture.target.shopRef, bindingId: pspFixture.target.bindingRef, boundAt: pspFixture.target.boundAt },
      { applicationId: pspFixture.applicationRef, customerId: pspFixture.customerRef, shopId: pspFixture.target.shopRef, bindingId: "older-binding", boundAt: pspFixture.target.boundAt }] } }; };
  await mock.receive({ input: { scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef, question: "Resolve this binding." } }); await mock.closed;
  const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view); assert.equal(view.state, "stopped"); assert.equal(view.stopReason, "invalid_request");
  assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send"), false);
});

test("the PSP log-only alias cannot be selected as a code repository", async () => {
  const mock = createMockTroubleshooting({ pspObservation: pspFixture, agent: async (_context, request) => {
    await request.invoke("logs.read", null); await request.invoke("code.search", { repositoryRef: "psp-log-source" }); return request.generate(request.diagnose());
  } });
  await mock.receive({ input: { scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef,
    bindingId: pspFixture.target.bindingRef, question: "Keep log and code authority distinct." } }); await mock.closed;
  const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view); assert.equal(view.state, "stopped"); assert.equal(view.stopReason, "denied");
  assert.equal(mock.events.some((event) => event.action === "code.search" || event.action === "delivery.send"), false);
});


test("a PSP-only approved source cannot silently enable Simulator intake", async () => {
  const mock = createMockTroubleshooting({ pspObservation: pspFixture, resourceRefs: ["psp-log-source", "psp-code"] });
  const application = new Troubleshooting(mock.ports, { mode: "mock", snapshotRef: "simulator-snapshot-1", resourceRefs: ["psp-log-source", "psp-code"],
    psp: { sourceRef: "psp-log-source", repositoryRef: "psp-code" }, queryWindow: { from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z" } });
  assert.deepEqual(await application.accept(mock.inbound), { status: "service_unavailable", reason: "contract_unverified" });
  assert.equal(mock.events.some((event) => event.action === "logs.read" || event.action === "model.generate"), false);
});


test("an actual earlier-phase PSP draft cannot be selected after a trusted binding reply", async () => {
  let old: import("../../src/troubleshooting/domain/simulator.js").DiagnosticReport | undefined;
  const mock = createMockTroubleshooting({ pspObservation: pspFixture, candidate: (draft) => { assert.ok(draft.scene === "psp"); return { reportRef: draft.reportRef, draftVersion: draft.draftVersion }; },
    agent: async (context, request) => { if (context.phaseId === 1) old = request.diagnose(); await request.invoke("logs.read", null); await request.invoke("code.search", null); return request.generate(old!); } });
  const read = mock.ports.logs.read;
  mock.ports.logs.read = async (context, query) => { const result = await read(context, query); return query.bindingId ? result : { ...result,
    value: { kind: "psp_target_candidates", candidates: [
      { applicationId: pspFixture.applicationRef, customerId: pspFixture.customerRef, shopId: pspFixture.target.shopRef, bindingId: "old-binding", boundAt: "2026-10-17T00:00:00.000Z" },
      { applicationId: pspFixture.applicationRef, customerId: pspFixture.customerRef, shopId: pspFixture.target.shopRef, bindingId: pspFixture.target.bindingRef, boundAt: pspFixture.target.boundAt },
    ] } }; };
  await mock.receive({ input: { scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef, question: "Select current draft only." } }); await mock.phaseClosed(1);
  assert.equal((await mock.application.provideInformation({ ...mock.inbound, eventRef: "select-second", reply: { caseRef: "case-1", questionId: "case-1:question:1" }, content: { candidateRef: "candidate-2" } })).status, "resumed");
  await mock.phaseClosed(2);
  const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view); assert.equal(view.state, "stopped"); assert.equal(view.stopReason, "unsafe_content");
  assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
});

test("PSP retention removes report and evidence through C without resetting cumulative ledger spend", async () => {
  const clock = new ManualClock(), actor = { principalRef: "lifecycle-owner", tenantRef: "tenant-1", destinationRef: "lifecycle-path" };
  const mock = createMockTroubleshooting({ pspObservation: pspFixture, clock, lifecycleActors: [actor] });
  await mock.receive({ input: { scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef, bindingId: pspFixture.target.bindingRef, question: "Explain PSP." } }); await mock.closed;
  const before = await mock.ports.budget.status("case-1"); assert.ok(before.pocMicrousd > 0);
  await mock.ports.retention!.recordTrigger(actor, { triggerRef: "terminated-psp", kind: "terminated", scope: "poc", decidedAt: clock.utc() });
  clock.advance(30 * 86_400_000);
  assert.equal((await mock.ports.retention!.purgeDue(actor)).state, "deleted");
  assert.equal(await mock.ports.records.read(mock.inbound, "case-1"), null); assert.equal(await mock.ports.records.export(mock.inbound, "case-1"), null);
  assert.deepEqual(await mock.application.get(mock.inbound, "case-1"), { status: "denied" });
  const after = await mock.ports.budget.status("case-1"); assert.equal(after.pocMicrousd, before.pocMicrousd); assert.equal(after.attempts, before.attempts);
});

test("a PSP execution timestamp before the selected business binding does not prove its branch", async () => {
  const observation = { ...pspFixture, executions: [{ ruleRef: "synthetic-timeout", stage: "first" as const, outcome: "timeout" as const,
    codeCommit: "1".repeat(40), eventRef: "before-binding", observedAt: "2026-10-18T09:00:00.000Z" }] };
  const mock = createMockTroubleshooting({ pspObservation: observation }); const search = mock.ports.code.search;
  mock.ports.code.search = async (context, query) => { const result = await search(context, query); return { ...result,
    evidence: result.evidence.map((item) => ({ ...item, code: { ...item.code!, pspRule: { ruleRef: "synthetic-timeout", stage: "first", outcome: "timeout", prerequisite: "one_passed_shop" } as const } })) }; };
  await mock.receive({ input: { scenario: "psp", applicationId: observation.applicationRef, shopId: observation.target.shopRef, bindingId: observation.target.bindingRef, question: "Check the binding's execution evidence." } }); await mock.closed;
  const report = (await mock.delivery.next()).report; assert.ok(report.scene === "psp"); assert.deepEqual(report.psp.branches, []);
});
