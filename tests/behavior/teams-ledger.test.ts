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

function ticket(caseRef: string, destinationRef: string, text: string, confirmed: () => boolean = () => false) {
  let claimed = false;
  const bindingRef = createHash("sha256").update(JSON.stringify([destinationRef, caseRef, 1, text])).digest("hex");
  return { bindingRef, ticket: { caseRef, deliveryKey: `${caseRef}:report:1`, segment: 1, bindingRef, callId: `${caseRef}:send`, kind: "report" as const, dispatch: { claim: () => { if (claimed) return false; claimed = true; return true; } }, completion: { get confirmed() { return confirmed(); } } } };
}

test("D bounded delivery cache reconciles completed entries with C without exhausting lifetime sends or replaying old keys", async () => {
  const services = await teamsServices(), mock = createMockTroubleshooting();
  const ledger = new Map<string, DeliveryRecord>(), pendingKeys = new Set<string>(), attempts = new Map<number, DeliveryAttempt>(); let writes = 0, current = 0;
  const attempt = (index: number): DeliveryAttempt => { const previous = attempts.get(index); if (previous) return previous; const created = { caseRef: `case-${index}`, phaseId: 1, segment: 1, total: 1, text: "safe status", ...ticket(`case-${index}`, services.mapping.actor.destinationRef, "safe status"), deadline: 5_000, signal: new AbortController().signal, beforeWrite: async () => {}, current: () => {} }; attempts.set(index, created); return created; };
  mock.ports.deliveryLedger.read = async (_actor, query) => { if (pendingKeys.has(query.caseRef)) return { state: "pending" }; const entry = ledger.get(query.caseRef); return entry ? entry.bindingRef === query.bindingRef
    ? { state: "complete", result: { status: entry.status, ...(entry.receiptRef ? { receiptRef: entry.receiptRef } : {}) } } : { state: "binding_mismatch" } : { state: "absent" }; };
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
    pendingKeys.add("case-1");
    assert.equal(await wire.delivery.send(services.mapping.actor.destinationRef, {} as never, "case-1:report:1", attempt(1)), "unknown");
    assert.equal(writes, 4_100, "an evicted original pending ticket never gains another physical dispatch");
    ledger.set("case-unknown", { schemaVersion: 1, caseRef: "case-unknown", deliveryKey: "case-unknown:report:1", segment: 1, callId: "prior-unknown", status: "unknown",
      bindingRef: createHash("sha256").update(JSON.stringify([services.mapping.actor.destinationRef, "case-unknown", 1, "safe status"])).digest("hex") });
    for (const repeat of [1, 2]) { void repeat; assert.deepEqual(await wire.delivery.send(services.mapping.actor.destinationRef, {} as never, "case-unknown:report:1", { ...attempt(0), caseRef: "case-unknown", ...ticket("case-unknown", services.mapping.actor.destinationRef, "safe status") }), { status: "unknown" }); }
    assert.equal(writes, 4_100);
    assert.deepEqual(await wire.delivery.send(services.mapping.actor.destinationRef, {} as never, "case-0:report:1", attempt(0)), first);
    assert.equal(writes, 4_100);
    assert.equal(await wire.delivery.send(services.mapping.actor.destinationRef, {} as never, "case-0:report:1", { ...attempt(0), text: "changed", ...ticket("case-0", services.mapping.actor.destinationRef, "changed") }), "failed"); assert.equal(writes, 4_100);
  } finally { await wire.close(); await services.close(); }
});

test("D can retire durably completed old sends after every old requester loses C read access without blocking a new requester", async () => {
  const service = await teamsServices(), oldActor = service.mapping.actor, newActor = { ...oldActor, principalRef: "principal-2", destinationRef: "private-2" };
  const mock = createMockTroubleshooting({ authorizedActors: [oldActor, newActor] }), committed = new Set<string>();
  const configuration = { ...service.configuration, mappings: [service.mapping, { ...service.mapping, userId: "synthetic-user-2", oid: "synthetic-oid-2", conversationId: "synthetic-conversation-2", actor: newActor }] };
  let writes = 0, oldReads = 0;
  mock.ports.deliveryLedger.read = async (actor, _query) => {
    if (actor.principalRef === oldActor.principalRef) { oldReads++; return null; }
    return { state: "absent" };
  };
  const wire = teamsWire(configuration, mock.ports);
  wire.bind({ send: async () => { writes++; return { id: `receipt-${writes}` }; } } as unknown as App, {} as never);
  const attempt = (caseRef: string) => ({ caseRef, phaseId: 1, segment: 1, total: 1, text: "safe status", deadline: 5_000,
    signal: new AbortController().signal, beforeWrite: async () => {}, current: () => {}, ...ticket(caseRef, caseRef.startsWith("old-") ? oldActor.destinationRef : newActor.destinationRef, "safe status", () => committed.has(caseRef)) });
  try {
    for (let index = 0; index < 4_096; index++) { const ref = `old-${index}`; await wire.delivery.send(oldActor.destinationRef, {} as never, `${ref}:report:1`, attempt(ref)); committed.add(ref); }
    const next = await wire.delivery.send(newActor.destinationRef, {} as never, "new-1:report:1", attempt("new-1"));
    assert.equal(typeof next === "object" ? next.status : next, "delivered"); assert.equal(writes, 4_097); assert.equal(oldReads, 0, "cache retirement does not read an old case using either principal");
    // old-0 was evicted. Its own withdrawn C permission prevents result recovery and any physical replay.
    assert.equal(await wire.delivery.send(oldActor.destinationRef, {} as never, "old-0:report:1", attempt("old-0")), "failed"); assert.equal(writes, 4_097);
  } finally { await wire.close(); await service.close(); }
});

test("D isolates unaudited fixed fault capacity so historical faults cannot disable ordinary delivery or replay an unknown fault", async () => {
  const service = await teamsServices(), mock = createMockTroubleshooting(), configuration = service.configuration;
  const wire = teamsWire(configuration, mock.ports), notice = "Investigation stopped because audit storage is unavailable." as const;
  let writes = 0;
  wire.bind({ api: { users: { getToken: async () => ({ token: "synthetic-user-proof" }) } }, send: async (conversationId: string, activity: { text: string }) => {
    // The external SDK/transport stand-in still passes its final bytes through the real wire interceptor.
    await wire.interceptor.request!({ config: { data: { type: "message", text: activity.text, textFormat: "plain", from: { id: configuration.clientId, role: "bot" }, conversation: { id: conversationId } }, headers: { set() {} } } } as never);
    if (++writes === 1) throw new Error("synthetic_ack_lost_after_write");
    return { id: `receipt-${writes}` };
  } } as unknown as App, { validateAccessToken: async () => ({ aud: configuration.user.audience, iss: configuration.user.issuer, tid: service.mapping.tenantId,
    oid: service.mapping.oid, scp: "access_as_user", exp: Date.now() / 1000 + 300 }) } as never);
  const attempt = (caseRef: string, text: string): DeliveryAttempt => ({ caseRef, phaseId: 1, segment: 1, total: 1, text, ...ticket(caseRef, service.mapping.actor.destinationRef, text), deadline: 5_000,
    signal: new AbortController().signal, beforeWrite: async () => {}, current: () => {} });
  try {
    assert.equal(await wire.delivery.fault(service.mapping.actor.destinationRef, notice, "fault-0:audit-fault", attempt("fault-0", notice)), "unknown");
    for (let index = 1; index < 4_096; index++) await wire.delivery.fault(service.mapping.actor.destinationRef, notice, `fault-${index}:audit-fault`, attempt(`fault-${index}`, notice));
    const before = writes;
    assert.equal(before, 32, "the bounded unaudited fault cache refuses additional fault writes");
    const normal = await wire.delivery.send(service.mapping.actor.destinationRef, {} as never, "normal-1:report:1", attempt("normal-1", "Synthetic ordinary report."));
    assert.equal(typeof normal === "object" ? normal.status : normal, "delivered"); assert.equal(writes, before + 1);
    assert.equal(await wire.delivery.fault(service.mapping.actor.destinationRef, notice, "fault-0:audit-fault", attempt("fault-0", notice)), "unknown"); assert.equal(writes, before + 1);
    assert.equal(await wire.delivery.send(service.mapping.actor.destinationRef, {} as never, "fault-0:audit-fault", attempt("fault-0", notice)), "unknown"); assert.equal(writes, before + 1);
  } finally { await wire.close(); await service.close(); }
});
