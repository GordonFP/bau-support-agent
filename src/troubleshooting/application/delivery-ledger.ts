import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CallContext, Ports, TrustedActor } from "./ports.js";
import type { AuditDetails, DeliveryRecord, SavedContext } from "./records.js";
import { recordAccessContext, recordActor, recordRole } from "./record-access.js";
import { deniedContext, recordDenial } from "./authorization-audit.js";
import { contextSnapshot, sameCaseAuthority, savedContextSnapshot } from "./record-contract.js";

export interface DeliveryBinding { readonly destinationRef: string; readonly caseRef: string; readonly phaseId: number; readonly text: string }
export interface DeliveryKey { readonly caseRef: string; readonly deliveryKey: string; readonly segment: number; readonly bindingRef: string }
export interface DeliveryOutcome { readonly status: "delivered" | "unknown" | "failed"; readonly receiptRef?: string }
export type DeliveryReceipt = { readonly state: "absent" | "pending" | "binding_mismatch" } | { readonly state: "complete"; readonly result: DeliveryOutcome };
export interface DeliveryTicket extends DeliveryKey { readonly callId: string; readonly kind: "report" | "notice"; readonly dispatch: { claim(): boolean }; readonly completion: { readonly confirmed: boolean } }
export interface DeliveryIntent { readonly kind: "report" | "notice"; readonly deliveryKey: string; readonly segment: number; readonly binding: DeliveryBinding }
export interface DeliveryLedger {
  begin(context: CallContext, input: DeliveryIntent): Promise<{ readonly state: "new"; readonly ticket: DeliveryTicket } | { readonly state: "existing"; readonly receipt: DeliveryReceipt; readonly bindingRef: string }>;
  complete(context: CallContext, ticket: DeliveryTicket, result: DeliveryOutcome): Promise<void>;
  read(actor: TrustedActor, query: DeliveryKey): Promise<DeliveryReceipt | null>;
}
export interface StoredDelivery extends DeliveryRecord { readonly stage: "pending" | "complete"; readonly kind: "report" | "notice" }
export interface DeliveryStorage {
  atomic<T>(operation: () => T): T;
  owner(caseRef: string): SavedContext | null;
  find(key: Pick<DeliveryKey, "deliveryKey" | "segment">): StoredDelivery | null;
  operation(callId: string, kind: "report" | "notice"): StoredDelivery | null;
  put(record: StoredDelivery): void;
  audit(context: CallContext, action: string, stage: "intent" | "complete", outcome: string, details: AuditDetails): void;
}

// Legacy bytes are deliberately stable. Only C encodes delivery bindings.
export function deliveryBinding(binding: DeliveryBinding): string {
  return createHash("sha256").update(JSON.stringify([binding.destinationRef, binding.caseRef, binding.phaseId, binding.text])).digest("hex");
}
export function deliveryRecord({ stage: _stage, kind: _kind, ...record }: StoredDelivery): DeliveryRecord { return record; }
function keyValid(query: DeliveryKey): void {
  if (typeof query.caseRef !== "string" || typeof query.deliveryKey !== "string" || !query.deliveryKey.startsWith(`${query.caseRef}:`) || !Number.isSafeInteger(query.segment) || query.segment < 1 || typeof query.bindingRef !== "string" || !/^[a-f0-9]{64}$/.test(query.bindingRef)) throw new Error("invalid_request");
}
function receipt(record: StoredDelivery | null, query: DeliveryKey): DeliveryReceipt {
  if (!record) return { state: "absent" };
  if (record.caseRef !== query.caseRef || record.bindingRef !== query.bindingRef) return { state: "binding_mismatch" };
  return record.stage === "complete" ? { state: "complete", result: { status: record.status, ...(record.receiptRef ? { receiptRef: record.receiptRef } : {}) } } : { state: "pending" };
}
// This detached confirmation owns only a bit; no case/phase context can be retained by D's cache.
function confirmation() { let confirmed = false, claimed = false; return { dispatch: Object.freeze({ claim() { if (claimed) return false; claimed = true; return true; } }), value: Object.freeze({ get confirmed() { return confirmed; } }), confirm() { confirmed = true; } }; }

export function createDeliveryLedger(storage: DeliveryStorage, controls: Pick<Ports, "authorization" | "clock" | "audit" | "sanitization"> & { readonly retention?: Ports["retention"] }): DeliveryLedger {
  const issued = new WeakMap<DeliveryTicket, { owner: SavedContext; phaseId: number; kind: "report" | "notice"; confirm: () => void }>();
  const atomic = <T>(operation: () => T): T => {
    try { return storage.atomic(operation); }
    catch (error) {
      if (error instanceof Error && ["denied", "invalid_request", "unsafe_content"].includes(error.message)) throw error;
      throw new Error("audit_unavailable");
    }
  };
  const open = () => { if (controls.retention?.closed()) throw new Error("denied"); };
  const ownerFor = (context: CallContext) => {
    open(); const owner = storage.owner(context.caseRef);
    if (!owner || !sameCaseAuthority(context, owner)) throw new Error("denied");
    return owner;
  };
  return {
    async begin(context, input) {
      context = contextSnapshot(context);
      try { input = structuredClone(input); } catch { throw new Error("invalid_request"); }
      const owner = ownerFor(context);
      const action = input.kind === "report" ? "delivery.send" : "delivery.notice";
      if (!await controls.authorization.allows(action, context)) { await recordDenial(controls.audit, context); throw new Error("denied"); }
      ownerFor(context);
      if (controls.authorization.current && controls.authorization.current(action, context) !== true) throw new Error("denied");
      if (!["report", "notice"].includes(input.kind) || input.binding.caseRef !== context.caseRef || input.binding.destinationRef !== context.destinationRef ||
        input.binding.phaseId !== context.phaseId || typeof input.binding.text !== "string" || !controls.sanitization.safe(input.binding.text)) throw new Error("invalid_request");
      const key = { caseRef: context.caseRef, deliveryKey: input.deliveryKey, segment: input.segment, bindingRef: deliveryBinding(input.binding) };
      keyValid(key);
      const previousOperation = storage.operation(context.callId, input.kind);
      if (previousOperation && (previousOperation.caseRef !== key.caseRef || previousOperation.deliveryKey !== key.deliveryKey ||
        previousOperation.segment !== key.segment)) throw new Error("invalid_request");
      const existing = storage.find(key);
      if (existing) return { state: "existing", receipt: receipt(existing, key), bindingRef: key.bindingRef };
      open();
      return atomic(() => {
        const record: StoredDelivery = { schemaVersion: 1, ...key, callId: context.callId, status: "unknown", stage: "pending", kind: input.kind };
        storage.put(record);
        storage.audit(context, input.kind === "report" ? "delivery.send" : "delivery.notice", "intent", "pending", { delivery: { deliveryKey: key.deliveryKey, segment: key.segment, bindingRef: key.bindingRef } });
        const completion = confirmation();
        const ticket = Object.freeze({ ...key, callId: context.callId, kind: input.kind, dispatch: completion.dispatch, completion: completion.value });
        issued.set(ticket, { owner: savedContextSnapshot(owner), phaseId: context.phaseId, kind: input.kind, confirm: completion.confirm });
        return { state: "new", ticket };
      });
    },
    async complete(context, ticket, result) {
      context = contextSnapshot(context);
      try { result = structuredClone(result); } catch { throw new Error("invalid_request"); }
      if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).some((key) => !["status", "receiptRef"].includes(key)) ||
        !["delivered", "unknown", "failed"].includes(result.status) || (result.receiptRef !== undefined &&
          (typeof result.receiptRef !== "string" || !/^[a-f0-9]{64}$/.test(result.receiptRef)))) throw new Error("invalid_request");
      ownerFor(context); keyValid(ticket);
      const issuedTicket = issued.get(ticket);
      if (!issuedTicket || context.callId !== ticket.callId || context.phaseId !== issuedTicket.phaseId || !sameCaseAuthority(context, issuedTicket.owner)) throw new Error("invalid_request");
      // No await separates the checked transition from its transaction on this single-owner store.
      const previous = storage.find(ticket);
      if (!previous || previous.callId !== ticket.callId || previous.bindingRef !== ticket.bindingRef) throw new Error("invalid_request");
      const record: StoredDelivery = { ...previous, status: result.status, ...(result.receiptRef ? { receiptRef: result.receiptRef } : {}), stage: "complete" };
      if (previous.stage === "complete") {
        if (!isDeepStrictEqual(previous, record)) throw new Error("invalid_request");
      } else atomic(() => {
        storage.put(record);
        storage.audit(context, issuedTicket.kind === "report" ? "delivery.send" : "delivery.notice", "complete", result.status === "delivered" ? "ok" : result.status, { delivery: { deliveryKey: ticket.deliveryKey, segment: ticket.segment, bindingRef: ticket.bindingRef, ...result } });
      });
      issuedTicket.confirm();
    },
    async read(actor, query) {
      actor = recordActor(actor); query = Object.freeze({ ...query }); keyValid(query);
      if (controls.retention?.closed()) return null;
      const owner = storage.owner(query.caseRef);
      const role = owner ? await recordRole(controls.authorization, actor, owner, "records.read") : null;
      if (!owner || !role || role === "business_reviewer") { await recordDenial(controls.audit, deniedContext(actor, query.caseRef, controls)); return null; }
      const context = recordAccessContext(actor, owner, role, `${query.caseRef}:delivery-receipt:${randomUUID()}`, controls.clock.now());
      await controls.audit.intent(context, "records.read");
      const result = receipt(storage.find(query), query);
      await controls.audit.complete(context, "records.read", "allowed");
      if (controls.retention?.closed() || await recordRole(controls.authorization, actor, owner, "records.read") !== role ||
        (controls.authorization.current && controls.authorization.current("records.read", { ...owner, ...actor }) !== true)) return null;
      return result;
    },
  };
}
