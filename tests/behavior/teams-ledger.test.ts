import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { App } from "@microsoft/teams.apps";
import { teamsReceiptRef } from "../../src/adapters/teams/identity.js";
import { teamsWire } from "../../src/adapters/teams/wire.js";
import { teamsServices } from "../fixtures/teams.js";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import type { DeliveryAttempt, DeliveryResult } from "../../src/troubleshooting/application/communication.js";
import type { DeliveryRecord } from "../../src/troubleshooting/application/records.js";

test("D bounded delivery cache reconciles completed entries with C without exhausting lifetime sends or replaying old keys", async () => {
  const services = await teamsServices(), mock = createMockTroubleshooting();
  const ledger = new Map<string, DeliveryRecord>(); let writes = 0, current = 0;
  const attempt = (index: number): DeliveryAttempt => ({ caseRef: `case-${index}`, phaseId: 1, segment: 1, total: 1, text: "safe status", deadline: 5_000, signal: new AbortController().signal, beforeWrite: async () => {}, current: () => {} });
  mock.ports.records.read = async (_actor, caseRef) => { const entry = ledger.get(caseRef); return { scope: "full", view: {} as never, records: [], deliveries: entry ? [entry] : [], audits: entry ? [{ stage: "complete", action: "delivery.send", delivery: { deliveryKey: entry.deliveryKey, segment: 1 }, callId: entry.callId }] : [] }; };
  const wire = teamsWire(services.configuration, mock.ports);
  // The SDK send is the external transport stand-in; C is an independent persisted-result stand-in.
  wire.bind({ send: async () => {
    writes++; const item = attempt(current);
    ledger.set(item.caseRef, { schemaVersion: 1, caseRef: item.caseRef, deliveryKey: `${item.caseRef}:report:1`, segment: 1, callId: `call-${current}`, status: "delivered", receiptRef: teamsReceiptRef(services.mapping, `receipt-${current}`),
      bindingRef: createHash("sha256").update(JSON.stringify([services.mapping.actor.destinationRef, item.caseRef, 1, item.text])).digest("hex") });
    return { id: `receipt-${current}` };
  } } as unknown as App, {} as never);
  let first: DeliveryResult | undefined;
  try {
    for (let index = 0; index < 4_100; index++) { current = index; const result = await wire.delivery.send(services.mapping.actor.destinationRef, {} as never, `case-${index}:report:1`, attempt(index)); assert.equal(typeof result === "object" ? result.status : result, "delivered"); if (index === 0) { first = result; ledger.delete("case-0"); } }
    assert.equal(writes, 4_100);
    ledger.set("case-unknown", { schemaVersion: 1, caseRef: "case-unknown", deliveryKey: "case-unknown:report:1", segment: 1, callId: "prior-unknown", status: "unknown",
      bindingRef: createHash("sha256").update(JSON.stringify([services.mapping.actor.destinationRef, "case-unknown", 1, "safe status"])).digest("hex") });
    for (const repeat of [1, 2]) { void repeat; assert.deepEqual(await wire.delivery.send(services.mapping.actor.destinationRef, {} as never, "case-unknown:report:1", { ...attempt(0), caseRef: "case-unknown" }), { status: "unknown" }); }
    assert.equal(writes, 4_100);
    assert.deepEqual(await wire.delivery.send(services.mapping.actor.destinationRef, {} as never, "case-0:report:1", attempt(0)), first);
    assert.equal(writes, 4_100);
    assert.equal(await wire.delivery.send(services.mapping.actor.destinationRef, {} as never, "case-0:report:1", { ...attempt(0), text: "changed" }), "failed"); assert.equal(writes, 4_100);
  } finally { await wire.close(); await services.close(); }
});

test("D can retire durably completed old sends after every old requester loses C read access without blocking a new requester", async () => {
  const service = await teamsServices(), oldActor = service.mapping.actor, newActor = { ...oldActor, principalRef: "principal-2", destinationRef: "private-2" };
  const mock = createMockTroubleshooting({ authorizedActors: [oldActor, newActor] }), committed = new Set<string>();
  const configuration = { ...service.configuration, mappings: [service.mapping, { ...service.mapping, userId: "synthetic-user-2", oid: "synthetic-oid-2", conversationId: "synthetic-conversation-2", actor: newActor }] };
  let writes = 0, oldReads = 0;
  mock.ports.records.read = async (actor, caseRef) => {
    if (actor.principalRef === oldActor.principalRef) { oldReads++; return null; }
    return { scope: "full", view: {} as never, records: [], audits: [], deliveries: [] };
  };
  const wire = teamsWire(configuration, mock.ports);
  wire.bind({ send: async () => { writes++; return { id: `receipt-${writes}` }; } } as unknown as App, {} as never);
  const attempt = (caseRef: string) => ({ caseRef, phaseId: 1, segment: 1, total: 1, text: "safe status", deadline: 5_000,
    signal: new AbortController().signal, beforeWrite: async () => {}, current: () => {}, durablyCompleted: () => committed.has(caseRef) });
  try {
    for (let index = 0; index < 4_096; index++) { const ref = `old-${index}`; await wire.delivery.send(oldActor.destinationRef, {} as never, `${ref}:report:1`, attempt(ref)); committed.add(ref); }
    const next = await wire.delivery.send(newActor.destinationRef, {} as never, "new-1:report:1", attempt("new-1"));
    assert.equal(typeof next === "object" ? next.status : next, "delivered"); assert.equal(writes, 4_097); assert.equal(oldReads, 0, "cache retirement does not read an old case using either principal");
    // old-0 was evicted. Its own withdrawn C permission prevents result recovery and any physical replay.
    assert.equal(await wire.delivery.send(oldActor.destinationRef, {} as never, "old-0:report:1", attempt("old-0")), "failed"); assert.equal(writes, 4_097);
  } finally { await wire.close(); await service.close(); }
});
