import { randomUUID } from "node:crypto";
import type { CallContext, Ports, TrustedActor } from "./ports.js";

export function deniedContext(actor: TrustedActor | null | undefined, caseRef: string, controls: Pick<Ports, "clock" | "sanitization">): CallContext {
  const ref = (value: unknown) => {
    try { return typeof value === "string" && /^[a-zA-Z0-9:_-]{1,256}$/.test(value) && controls.sanitization.safe(value) ? value : "unresolved"; }
    catch { return "unresolved"; }
  };
  return { principalRef: ref(actor?.principalRef), tenantRef: ref(actor?.tenantRef), destinationRef: ref(actor?.destinationRef),
    caseRef: ref(caseRef), phaseId: 0, callId: `authorization:${randomUUID()}`, resourceRefs: [], policyVersion: "unapproved",
    approvalRef: "unapproved", snapshotRef: "unapproved", budgetRef: "unapproved", deadline: controls.clock.now(), signal: new AbortController().signal };
}

export async function recordDenial(audit: Ports["audit"], context: CallContext): Promise<void> {
  const operation = { ...context, callId: `${context.caseRef}:denied:${randomUUID()}` };
  await audit.intent(operation, "authorization.denied");
  await audit.complete(operation, "authorization.denied", "denied");
}
