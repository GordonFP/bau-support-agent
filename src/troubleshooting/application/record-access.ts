import type { CallContext, Ports, TrustedActor } from "./ports.js";
import { savedContextSnapshot } from "./record-contract.js";
import type { RecordDisclosure, RecordRole, SavedContext, StoredCase } from "./records.js";

export const recordActor = (actor: TrustedActor): TrustedActor => Object.freeze({ principalRef: actor?.principalRef,
  tenantRef: actor?.tenantRef, destinationRef: actor?.destinationRef });

const sameActor = (actor: TrustedActor, owner: TrustedActor) => !!actor && actor.principalRef === owner.principalRef &&
  actor.tenantRef === owner.tenantRef && actor.destinationRef === owner.destinationRef;

export async function recordRole(authorization: Ports["authorization"], actor: TrustedActor, owner: SavedContext, action: string): Promise<RecordRole | null> {
  actor = recordActor(actor);
  owner = savedContextSnapshot(owner);
  if (!actor || ![actor.principalRef, actor.tenantRef, actor.destinationRef].every((value) => typeof value === "string" && value.length > 0)) return null;
  const grant = authorization.recordGrant ? await authorization.recordGrant(actor, owner) :
    sameActor(actor, owner) ? { role: "requester" as const, caseRef: owner.caseRef, resourceRefs: owner.resourceRefs } : null;
  if (!grant || !["requester", "business_reviewer", "technical"].includes(grant.role) || grant.caseRef !== owner.caseRef ||
    actor.tenantRef !== owner.tenantRef || !Array.isArray(grant.resourceRefs) ||
    !owner.resourceRefs.every((ref) => grant.resourceRefs.includes(ref)) ||
    (grant.role === "requester" && !sameActor(actor, owner))) return null;
  return await authorization.allows(action, { ...owner, ...actor }) ? grant.role : null;
}

export function recordDisclosure(stored: StoredCase, role: RecordRole): RecordDisclosure {
  return role === "business_reviewer" ? { scope: "report_evidence", records: stored.records.filter((record) => ["report", "evidence"].includes(record.kind)),
    audits: [], deliveries: [] } : structuredClone(stored);
}

export function recordAccessContext(actor: TrustedActor, owner: SavedContext, role: RecordRole, callId: string, deadline: number): CallContext {
  return { ...owner, ...recordActor(actor), auditRole: role, callId, deadline, signal: new AbortController().signal };
}
