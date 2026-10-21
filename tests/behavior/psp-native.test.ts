import test from "node:test";
import assert from "node:assert/strict";
import { createLocalTeamsHost } from "../../src/adapters/teams/host.js";
import { responsesServer } from "../fixtures/responses.js";
import { nativeTroubleshooting, simulatorResponse } from "../fixtures/pi-runtime.js";
import { teamsServices } from "../fixtures/teams.js";
import { pspFixture } from "../fixtures/psp.js";

test("signed local Teams through actual Pi, Responses and native MCP produces the PSP unsupported report with C provenance", async () => {
  const teams = await teamsServices(); const model = await responsesServer(simulatorResponse);
  const { mock, pi } = await nativeTroubleshooting(model.baseUrl, { pspObservation: pspFixture }, "psp:unsupported");
  const host = await createLocalTeamsHost(teams.configuration, { application: mock.application, ports: mock.ports });
  try {
    await host.start();
    const response = await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${teams.serviceToken()}` },
      body: JSON.stringify(teams.activity(JSON.stringify({ action: "investigate", scenario: "psp", applicationId: pspFixture.applicationRef,
        shopId: pspFixture.target.shopRef, bindingId: pspFixture.target.bindingRef, question: "Explain this shop and PSP binding." }))) });
    assert.equal((await response.json() as { status: string }).status, "accepted"); await mock.closed;
    const saved = await mock.ports.records.read(teams.mapping.actor, "case-1"); assert.ok(saved?.scope === "full");
    assert.equal(saved.view.state, "completed", JSON.stringify(saved.view));
    const report = saved.records.find((item) => item.kind === "report")!.payload as import("../../src/troubleshooting/domain/simulator.js").DiagnosticReport;
    assert.ok(report.scene === "psp"); assert.equal(report.psp.support.status, "unsupported"); assert.equal(report.psp.second.status, "not_applicable");
    assert.equal(saved.audits.filter((entry) => entry.stage === "complete" && entry.action === "mcp.logs.read").length, 1);
    assert.equal(saved.audits.filter((entry) => entry.stage === "complete" && entry.action === "mcp.code.search").length, 1);
    assert.equal(model.requests.length, 3); assert.ok(teams.writes.length >= 2);
    assert.doesNotMatch(JSON.stringify({ saved, writes: teams.writes, requests: model.requests }), /SYNTHETIC-SECRET|\/Users\/|\/private\//);
  } finally { await host.stop(); await pi.close("case-1"); await model.close(); await teams.close(); }
});

for (const mode of ["unknown", "two_pass", "tail_failure", "other_passed", "missing", "waiting", "failed", "timeout", "fallback", "conflict"] as const) test(`actual local PSP ${mode} keeps applicability, execution and customer consequences distinct`, async () => {
  const teams = await teamsServices(); const model = await responsesServer(simulatorResponse);
  const { mock, pi } = await nativeTroubleshooting(model.baseUrl, { pspObservation: pspFixture }, `psp:${mode}`);
  const host = await createLocalTeamsHost(teams.configuration, { application: mock.application, ports: mock.ports });
  try {
    await host.start();
    const response = await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${teams.serviceToken()}` },
      body: JSON.stringify(teams.activity(JSON.stringify({ action: "investigate", scenario: "psp", applicationId: pspFixture.applicationRef,
        shopId: pspFixture.target.shopRef, bindingId: pspFixture.target.bindingRef, question: "Explain this PSP case." }))) });
    assert.equal((await response.json() as { status: string }).status, "accepted"); await mock.closed;
    const saved = await mock.ports.records.read(teams.mapping.actor, "case-1"); assert.ok(saved?.scope === "full"); assert.equal(saved.view.state, "completed", JSON.stringify(saved.view));
    const report = saved.records.find((item) => item.kind === "report")!.payload as import("../../src/troubleshooting/domain/simulator.js").DiagnosticReport; assert.ok(report.scene === "psp");
    if (mode === "unknown") { assert.equal(report.psp.support.status, "unknown"); assert.equal(report.psp.second.status, "unknown"); }
    if (mode === "two_pass") { assert.equal(report.psp.second.transaction.status, "passed"); assert.equal(report.psp.second.tailThree.status, "passed"); }
    if (mode === "tail_failure") { assert.equal(report.psp.second.transaction.status, "passed"); assert.equal(report.psp.second.tailThree.status, "failed"); assert.equal(report.psp.prerequisite, "unknown"); }
    if (mode === "other_passed") { assert.equal(report.psp.final.status, "uncontrolled"); assert.equal(report.psp.prerequisite, "met"); assert.ok(report.evidence.some((item) => item.completeness === "unknown")); }
    if (["missing", "waiting", "failed", "timeout", "fallback"].includes(mode)) assert.equal(report.psp.branches[0]?.outcome, mode);
    if (mode === "conflict") { assert.equal(report.psp.conflicts.length, 1); assert.equal(report.psp.prerequisite, "met"); }
    assert.equal(report.psp.initiation, "unknown"); assert.equal(report.psp.approval, "unknown"); assert.equal(report.psp.amount, null);
    assert.ok(teams.writes.length >= 2); assert.doesNotMatch(JSON.stringify({ saved, writes: teams.writes, requests: model.requests }), /SYNTHETIC-SECRET|\/Users\/|\/private\//);
  } finally { await host.stop(); await pi.close("case-1"); await model.close(); await teams.close(); }
});

test("actual signed PSP clarification binds a question receipt and resumes only the selected server-side binding", async () => {
  const teams = await teamsServices(), model = await responsesServer(simulatorResponse);
  const { mock, pi } = await nativeTroubleshooting(model.baseUrl, { pspObservation: pspFixture }, "psp:targets");
  const host = await createLocalTeamsHost(teams.configuration, { application: mock.application, ports: mock.ports });
  const post = async (text: object, id: string, replyToId?: string) => fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${teams.serviceToken()}` },
    body: JSON.stringify({ ...teams.activity(JSON.stringify(text)), id, ...(replyToId ? { replyToId } : {}) }) });
  try {
    await host.start();
    assert.equal((await (await post({ action: "investigate", scenario: "psp", customerId: pspFixture.customerRef, question: "Which shop and PSP binding?" }, "ask-target")).json() as { status: string }).status, "accepted");
    await mock.phaseClosed(1);
    const waiting = await mock.application.get(teams.mapping.actor, "case-1"); assert.ok("state" in waiting); assert.equal(waiting.state, "awaiting_input");
    const reply = { action: "provide_information", caseRef: "case-1", questionId: waiting.question!.questionId, content: { candidateRef: "candidate-2" } };
    assert.deepEqual(await (await post(reply, "unassociated-reply", "wrong-receipt")).json(), { status: "denied" });
    const receipt = `synthetic-receipt-${teams.writes.length}`;
    assert.equal((await (await post(reply, "selected-target", receipt)).json() as { status: string }).status, "resumed"); await mock.phaseClosed(2);
    const saved = await mock.ports.records.read(teams.mapping.actor, "case-1"); assert.ok(saved?.scope === "full"); assert.equal(saved.view.state, "completed", JSON.stringify(saved.view));
    const report = saved.records.find((item) => item.kind === "report")!.payload as import("../../src/troubleshooting/domain/simulator.js").DiagnosticReport; assert.ok(report.scene === "psp");
    assert.match(report.draftVersion, /:phase-2:/); assert.equal(report.psp.target?.boundAt, pspFixture.target.boundAt);
    assert.doesNotMatch(JSON.stringify({ saved, writes: teams.writes, model: model.requests }), /SYNTHETIC-SECRET|\/Users\/|\/private\//);
  } finally { await host.stop(); await pi.close("case-1"); await model.close(); await teams.close(); }
});

test("a signed PSP request with no source permission produces no report or native evidence action", async () => {
  const teams = await teamsServices(), model = await responsesServer(simulatorResponse);
  const { mock, pi } = await nativeTroubleshooting(model.baseUrl, { pspObservation: pspFixture, denyActions: ["logs.read"] }, "psp:unsupported");
  const host = await createLocalTeamsHost(teams.configuration, { application: mock.application, ports: mock.ports });
  try {
    await host.start();
    const response = await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${teams.serviceToken()}` },
      body: JSON.stringify(teams.activity(JSON.stringify({ action: "investigate", scenario: "psp", applicationId: pspFixture.applicationRef,
        shopId: pspFixture.target.shopRef, bindingId: pspFixture.target.bindingRef, question: "Explain this PSP case." }))) });
    assert.equal((await response.json() as { status: string }).status, "accepted"); await mock.closed;
    const saved = await mock.ports.records.read(teams.mapping.actor, "case-1"); assert.ok(saved?.scope === "full"); assert.equal(saved.view.state, "stopped"); assert.equal(saved.view.stopReason, "denied");
    assert.equal(saved.records.some((item) => item.kind === "report" || item.kind === "evidence"), false);
    assert.equal(saved.audits.some((item) => item.action === "mcp.logs.read"), false);
    assert.equal(teams.writes.some((write) => String(write.body.text).includes('"scene":"psp"')), false);
  } finally { await host.stop(); await pi.close("case-1"); await model.close(); await teams.close(); }
});

test("signed PSP cancellation after native logs discards the in-flight model result and retains unknown execution charges", async () => {
  const teams = await teamsServices(), held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let turns = 0;
  const model = await responsesServer(async (body, response) => { if (++turns === 2) { held.resolve(); await release.promise; }
    if (!response.destroyed) simulatorResponse(body, response); });
  const { mock, pi } = await nativeTroubleshooting(model.baseUrl, { pspObservation: pspFixture }, "psp:unsupported");
  const host = await createLocalTeamsHost(teams.configuration, { application: mock.application, ports: mock.ports });
  const post = (text: object, id: string) => fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${teams.serviceToken()}` }, body: JSON.stringify({ ...teams.activity(JSON.stringify(text)), id }) });
  try {
    await host.start();
    assert.equal((await (await post({ action: "investigate", scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef,
      bindingId: pspFixture.target.bindingRef, question: "Cancel this PSP case." }, "psp-start")).json() as { status: string }).status, "accepted");
    await held.promise;
    const response = await post({ action: "cancel", caseRef: "case-1" }, "psp-cancel"); assert.equal((await response.json() as { state: string }).state, "stopped");
    release.resolve(); await mock.closed;
    const saved = await mock.ports.records.read(teams.mapping.actor, "case-1"); assert.ok(saved?.scope === "full"); assert.equal(saved.view.state, "stopped"); assert.equal(saved.view.stopReason, "cancelled");
    assert.ok(saved.audits.some((item) => item.action === "mcp.logs.read" && item.stage === "complete"));
    assert.equal(saved.records.some((item) => item.kind === "report"), false); assert.equal(model.requests.length, 2);
    const budget = await mock.ports.budget.status("case-1"); assert.equal(budget.attempts, 2); assert.equal(budget.unsettledCalls, 1); assert.ok(budget.reservedMicrousd > 0);
    assert.equal(teams.writes.some((write) => String(write.body.text).includes('"scene":"psp"')), false);
  } finally { release.resolve(); await host.stop(); await pi.close("case-1"); await model.close(); await teams.close(); }
});

test("B rejects colliding sanitized PSP candidate bindings rather than overwriting their raw selectors", async () => {
  const { mock, pi } = await nativeTroubleshooting("http://127.0.0.1:1/v1", { pspObservation: pspFixture, controlPorts: (ports) => {
    const sanitize = ports.sanitization.sanitize;
    ports.sanitization.sanitize = <T>(value: T, caseRef: string): T => sanitize(typeof value === "string" ? value.replace("SYNTHETIC-SECRET-BINDING-OLD", "SYNTHETIC-SECRET-BINDING") as T : value, caseRef);
    return {};
  } }, "psp:targets");
  try {
    await assert.rejects(mock.ports.logs.read({ caseRef: "case-1", phaseId: 1, callId: "collision", principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1",
      policyVersion: "synthetic-policy", approvalRef: "synthetic-approval", resourceRefs: ["simulator-source", "psp-log-source", "psp-code"], snapshotRef: "simulator-snapshot-1", budgetRef: "case-1", deadline: mock.ports.clock.now() + 30_000, signal: new AbortController().signal },
      { sourceRef: "psp-log-source", customerId: pspFixture.customerRef, from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z", pageSize: 100 }), /^Error: unsafe_content$/);
  } finally { mock.ports.sanitization.clear("case-1"); await pi.close("case-1"); }
});


test("B binding overflow has one rejected completion and no successful audit", async () => {
  const { mock, pi } = await nativeTroubleshooting("http://127.0.0.1:1/v1", { pspObservation: pspFixture }, "psp:targets_overflow");
  try {
    await assert.rejects(mock.ports.logs.read({ caseRef: "case-1", phaseId: 1, callId: "binding-overflow", principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1",
      policyVersion: "synthetic-policy", approvalRef: "synthetic-approval", resourceRefs: ["simulator-source", "psp-log-source", "psp-code"], snapshotRef: "simulator-snapshot-1", budgetRef: "case-1", deadline: mock.ports.clock.now() + 30_000, signal: new AbortController().signal },
      { sourceRef: "psp-log-source", customerId: pspFixture.customerRef, from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z", pageSize: 100 }), /^Error: unsafe_content$/);
    const completions = mock.events.filter((event) => event.action === "audit:mcp.logs.read:complete").map((event) => event.input as { outcome: string });
    assert.deepEqual(completions.map((item) => item.outcome), ["unsafe_content"]);
  } finally { mock.ports.sanitization.clear("case-1"); await pi.close("case-1"); }
});
