import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalTeamsHost } from "../../src/adapters/teams/host.js";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { teamsServices } from "../fixtures/teams.js";

test("a committed acceptance keeps its idempotency but discloses no ACK metadata when case resources are revoked during the final user proof", async () => {
  const service = await teamsServices(), mock = createMockTroubleshooting();
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let revoked = false, proofs = 0;
  const allows = mock.ports.authorization.allows, current = mock.ports.authorization.current!;
  mock.ports.authorization.current = (action, context) => (action === "teams.identity" || !revoked) && current(action, context);
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
  const allows = mock.ports.authorization.allows, current = mock.ports.authorization.current!;
  mock.ports.authorization.current = (action, context) => (action === "teams.identity" || !revoked) && current(action, context);
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
  const allows = mock.ports.authorization.allows, current = mock.ports.authorization.current!;
  mock.ports.authorization.current = (action, context) => (action === "teams.identity" || !revoked) && current(action, context);
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

for (const waitingAction of ["delivery.send", "teams.identity"] as const) test(`final Teams write checks both grants after awaiting ${waitingAction}`, async () => {
  const service = await teamsServices(), denyActions: string[] = [], mock = createMockTroubleshooting({ denyActions });
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const allows = mock.ports.authorization.allows;
  mock.ports.authorization.allows = async (action, context) => { const allowed = await allows(action, context); if (action === waitingAction) { held.resolve(); await release.promise; } return allowed; };
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  const authority = { ...service.mapping.actor, resourceRefs: ["simulator-source"] };
  try {
    await host.start();
    const sending = mock.ports.delivery.send(service.mapping.actor.destinationRef, {} as never, "case-1:report:1", {
      caseRef: "case-1", phaseId: 1, segment: 1, total: 1, text: "Synthetic report.", deadline: 5_000, signal: new AbortController().signal,
      state: { kind: "new", ticket: { caseRef: "case-1", deliveryKey: "case-1:report:1", segment: 1, bindingRef: "a".repeat(64), callId: "case-1:send", kind: "report", dispatch: { claim: () => true }, completion: { confirmed: false } } },
      beforeWrite: async () => { if (!await mock.ports.authorization.allows("delivery.send", authority)) throw new Error("denied"); },
      current: () => { if (mock.ports.authorization.current!("delivery.send", authority) !== true) throw new Error("denied"); },
    });
    await held.promise; denyActions.push(waitingAction === "delivery.send" ? "teams.identity" : "delivery.send"); release.resolve();
    assert.equal(await sending, "failed"); assert.equal(service.writes.length, 0);
  } finally { release.resolve(); await host.stop(); await service.close(); }
});

test("final Teams query denies metadata when identity is revoked during resource authorization", async () => {
  const service = await teamsServices(), denyActions: string[] = [], mock = createMockTroubleshooting({ denyActions });
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const post = (body: unknown) => fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(body) });
  try {
    await host.start(); await post(service.activity()); await mock.closed;
    let reads = 0, gets = 0;
    const allows = mock.ports.authorization.allows;
    mock.ports.authorization.allows = async (action, context) => { const allowed = await allows(action, context); if ((action === "get" && ++gets === 2 || action === "records.read" && ++reads === 2)) { held.resolve(); await release.promise; } return allowed; };
    const querying = post({ ...service.activity(JSON.stringify({ action: "get", caseRef: "case-1" })), id: "held-get" });
    await held.promise; denyActions.push("teams.identity"); release.resolve();
    assert.deepEqual(await (await querying).json(), { status: "denied" });
  } finally { release.resolve(); await host.stop(); await service.close(); }
});

test("local Teams refuses an authority without a synchronous current policy fence", async () => {
  const service = await teamsServices(), mock = createMockTroubleshooting();
  delete mock.ports.authorization.current;
  try { await assert.rejects(createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports }), /contract_unverified/); }
  finally { await service.close(); }
});

test("restored Teams query keeps the identity fence current during final SQLite authorization", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { SqliteRecords } = await import("../../src/adapters/records/sqlite.js");
  const directory = await mkdtemp(join(tmpdir(), "bau-teams-current-"));
  const service = await teamsServices(), denyActions: string[] = [];
  let store: InstanceType<typeof SqliteRecords> | undefined, host: Awaited<ReturnType<typeof createLocalTeamsHost>> | undefined;
  const controls = (ports: ReturnType<typeof createMockTroubleshooting>["ports"]) => { store = new SqliteRecords(directory, ports); return { records: store.records, deliveryLedger: store.deliveryLedger, audit: store.audit, admission: store.admission, budget: store.budget }; };
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const post = (body: unknown) => fetch(host!.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(body) });
  try {
    const first = createMockTroubleshooting({ denyActions, controlPorts: controls });
    host = await createLocalTeamsHost(service.configuration, { application: first.application, ports: first.ports });
    await host.start(); await post(service.activity()); await first.closed; await host.stop(); store!.close();
    const restored = createMockTroubleshooting({ denyActions, controlPorts: controls });
    host = await createLocalTeamsHost(service.configuration, { application: restored.application, ports: restored.ports }); await host.start();
    let reads = 0; const allows = restored.ports.authorization.allows;
    restored.ports.authorization.allows = async (action, context) => { const allowed = await allows(action, context); if (action === "records.read" && ++reads === 2) { held.resolve(); await release.promise; } return allowed; };
    const querying = post({ ...service.activity(JSON.stringify({ action: "get", caseRef: "case-1" })), id: "restored-current-get" });
    await held.promise; denyActions.push("teams.identity"); release.resolve();
    assert.deepEqual(await (await querying).json(), { status: "denied" });
  } finally { release.resolve(); await host?.stop(); store?.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const result of ["truthy", Promise.resolve(false)]) test(`Teams refuses a nonboolean synchronous current-policy result ${typeof result}`, async () => {
  const service = await teamsServices(), mock = createMockTroubleshooting();
  mock.ports.authorization.current = (() => result) as never;
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  try {
    await host.start();
    const reply = await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(service.activity()) });
    assert.deepEqual(await reply.json(), { status: "denied" }); assert.equal(service.writes.length, 0);
    assert.equal(mock.events.some((event) => event.action === "admission.confirm"), false);
  } finally { await host.stop(); await service.close(); }
});
