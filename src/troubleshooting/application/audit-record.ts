import type { CallContext } from "./ports.js";
import type { AuditDetails } from "./records.js";

export interface AuditCost {
  readonly source: string;
  readonly reserved: number;
  readonly actual: number | null;
}

export function auditRecord(context: CallContext, action: string, stage: string, outcome: string, occurredAt: string,
  details?: AuditDetails, cost?: AuditCost): Readonly<Record<string, unknown>> {
  if (details && Object.keys(details).some((key) => !["scope", "result", "delivery"].includes(key))) throw new Error("invalid_request");
  const scope = details?.scope;
  if (scope && Object.keys(scope).some((key) => !["sourceRef", "repositoryRef", "snapshotRef", "from", "to", "pageSize"].includes(key))) throw new Error("invalid_request");
  if (details?.result && (Object.keys(details.result).some((key) => !["completeness", "truncated", "evidenceCount"].includes(key)) ||
    !["complete", "partial", "unknown"].includes(details.result.completeness) || typeof details.result.truncated !== "boolean" ||
    !Number.isSafeInteger(details.result.evidenceCount) || details.result.evidenceCount < 0)) throw new Error("invalid_request");
  if (details?.delivery && Object.keys(details.delivery).some((key) => !["deliveryKey", "segment", "status"].includes(key))) throw new Error("invalid_request");
  return { schemaVersion: 1, occurredAt, principalRef: context.principalRef, role: action === "authorization.denied" ? "unresolved" : "requester",
    tenantRef: context.tenantRef, destinationRef: context.destinationRef, caseRef: context.caseRef, phaseId: context.phaseId, callId: context.callId, operationId: context.callId,
    resourceRefs: context.resourceRefs, policyVersion: context.policyVersion, approvalRef: context.approvalRef, snapshotRef: context.snapshotRef,
    toolSchemaVersion: "mock-schema-1", artifactVersion: "offline-simulator-1", sanitizationVersion: "mock-sanitization-1", sanitizationStatus: "validated_metadata",
    authorization: { decision: action === "authorization.denied" ? "denied" : "allowed", reason: action === "authorization.denied" ? "denied" : "policy_allowed" },
    scope: scope ?? {}, ...(details?.result ? { result: details.result } : {}), ...(details?.delivery ? { delivery: details.delivery } : {}),
    ...(cost ? { settlement: { source: cost.source, state: cost.actual === null ? "unknown" : "settled", reservedMicrousd: cost.reserved, actualMicrousd: cost.actual } } : {}),
    action, stage, outcome };
}
