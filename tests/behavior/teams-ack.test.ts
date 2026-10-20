import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalTeamsHost } from "../../src/adapters/teams/host.js";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { teamsServices } from "../fixtures/teams.js";

test("a committed acceptance keeps its idempotency but discloses no ACK metadata when case resources are revoked during the final user proof", async () => {
  const service = await teamsServices(), mock = createMockTroubleshooting();
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let revoked = false, proofs = 0;
  const allows = mock.ports.authorization.allows;
  mock.ports.authorization.allows = (action, context) => action === "teams.identity" || !revoked ? allows(action, context) : Promise.resolve(false);
  service.beforeToken(async () => { if (++proofs >= 2) { held.resolve(); await release.promise; } });
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  const post = () => fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(service.activity()) });
  try {
    await host.start(); const accepting = post(); await held.promise;
    assert.ok(mock.events.some((event) => event.action === "audit:accept:complete"));
    revoked = true; release.resolve();
    assert.deepEqual(await (await accepting).json(), { status: "denied" }); await mock.closed;
    assert.equal(service.writes.length, 0);
    assert.equal(mock.events.some((event) => ["logs.read", "model.generate"].includes(event.action)), false);
    revoked = false; service.beforeToken();
    assert.deepEqual(await (await post()).json(), { status: "duplicate", caseRef: "case-1", phaseId: 1 });
    assert.equal(mock.events.filter((event) => event.action === "admission.confirm").length, 1);
    assert.equal(service.writes.length, 0);
  } finally { release.resolve(); await host.stop(); await service.close(); }
});

test("idempotent cancel of a completed case repeats case disclosure authorization after its final user proof", async () => {
  const service = await teamsServices(), mock = createMockTroubleshooting();
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let revoked = false, proofs = 0;
  const allows = mock.ports.authorization.allows;
  mock.ports.authorization.allows = (action, context) => action === "teams.identity" || !revoked ? allows(action, context) : Promise.resolve(false);
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  const post = (body: unknown) => fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(body) });
  try {
    await host.start(); await post(service.activity()); await mock.closed;
    service.beforeToken(async () => { if (++proofs === 2) { held.resolve(); await release.promise; } });
    const cancelling = post({ ...service.activity(JSON.stringify({ action: "cancel", caseRef: "case-1" })), id: "terminal-cancel" });
    await held.promise; revoked = true; release.resolve();
    assert.deepEqual(await (await cancelling).json(), { status: "denied" }); assert.equal(service.writes.length, 2);
    revoked = false; service.beforeToken();
    const view = await mock.application.get(service.mapping.actor, "case-1"); assert.ok("state" in view); assert.equal(view.state, "completed");
    assert.equal(mock.events.filter((event) => event.action === "admission.confirm").length, 1);
  } finally { release.resolve(); await host.stop(); await service.close(); }
});

test("a trusted reply remains committed and idempotent while its ACK is denied after resource revocation in the final user proof", async () => {
  const service = await teamsServices();
  const candidates = [{ applicationId: "SYNTHETIC-SECRET-APPLICATION", submittedAt: "2026-10-18T10:00:00.000Z" },
    { applicationId: "SYNTHETIC-SECRET-APPLICATION-SECOND", submittedAt: "2026-10-18T15:00:00.000Z" }];
  const mock = createMockTroubleshooting({ customerCandidates: candidates });
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let revoked = false, proofs = 0;
  const allows = mock.ports.authorization.allows;
  mock.ports.authorization.allows = (action, context) => action === "teams.identity" || !revoked ? allows(action, context) : Promise.resolve(false);
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  const post = (body: unknown) => fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(body) });
  try {
    await host.start(); await post(service.activity(JSON.stringify({ action: "investigate", customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Which application?" })));
    await mock.phaseClosed(1);
    const waiting = await mock.application.get(service.mapping.actor, "case-1"); assert.ok("state" in waiting && waiting.question);
    const reply = { ...service.activity(JSON.stringify({ action: "provide_information", caseRef: "case-1", questionId: waiting.question.questionId,
      content: { submittedAt: candidates[1]!.submittedAt, candidateRef: "candidate-2" } })), id: "trusted-reply", replyToId: "synthetic-receipt-2" };
    const before = mock.events.filter((event) => event.action === "logs.read").length;
    service.beforeToken(async () => { if (++proofs >= 2) { held.resolve(); await release.promise; } });
    const resuming = post(reply); await held.promise;
    assert.ok(mock.events.some((event) => event.action === "audit:provideInformation:complete"));
    revoked = true; release.resolve();
    assert.deepEqual(await (await resuming).json(), { status: "denied" }); await mock.phaseClosed(2);
    assert.equal(mock.events.filter((event) => event.action === "logs.read").length, before); assert.equal(service.writes.length, 2);
    revoked = false; service.beforeToken();
    assert.deepEqual(await (await post(reply)).json(), { status: "duplicate", caseRef: "case-1", phaseId: 2 });
    assert.equal(mock.events.filter((event) => event.action === "audit:provideInformation:complete").length, 1);
    assert.equal(service.writes.length, 2);
  } finally { release.resolve(); await host.stop(); await service.close(); }
});
