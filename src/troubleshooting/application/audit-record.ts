import type { CallContext } from "./ports.js";
import type { AuditDetails } from "./records.js";

export interface AuditCost {
  readonly source: string;
  readonly reserved: number;
  readonly actual: number | null;
}

export function auditRecord(context: CallContext, action: string, stage: string, outcome: string, occurredAt: string,
  details?: AuditDetails, cost?: AuditCost): Readonly<Record<string, unknown>> {
  if (details && Object.keys(details).some((key) => !["scope", "result", "delivery", "tool", "model"].includes(key))) throw new Error("invalid_request");
  const model = details?.model;
  if (model && (Object.keys(model).some((key) => !["profile", "protocol", "schemaVersion", "artifactVersion"].includes(key)) ||
    model.schemaVersion !== "model-turn-1" || !(
      model.profile === "memory_mock" && model.protocol === "mock-json-byte-pairs-1" && model.artifactVersion === "offline-model-1" ||
      model.profile === "local_protocol" && model.protocol === "synthetic-responses-byte-pairs-1" && model.artifactVersion === "pi-ai-1.3.0" ||
      model.profile === "cpa_poc" && model.protocol === "cpa-poc-output-observation-1" && model.artifactVersion === "pi-ai-1.3.0"))) throw new Error("invalid_request");
  const tool = details?.tool;
  if (tool && (Object.keys(tool).some((key) => !["name", "schemaVersion", "artifactVersion", "manifestSha256", "sanitizationVersion"].includes(key)) ||
    ![tool.name, tool.schemaVersion, tool.artifactVersion, tool.sanitizationVersion].every((value) => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,96}$/.test(value)) ||
    !/^[a-f0-9]{64}$/.test(tool.manifestSha256))) throw new Error("invalid_request");
  const scope = details?.scope;
  if (scope && Object.keys(scope).some((key) => !["sourceRef", "repositoryRef", "snapshotRef", "from", "to", "pageSize"].includes(key))) throw new Error("invalid_request");
  if (details?.result && (Object.keys(details.result).some((key) => !["completeness", "truncated", "evidenceCount"].includes(key)) ||
    !["complete", "partial", "unknown"].includes(details.result.completeness) || typeof details.result.truncated !== "boolean" ||
    !Number.isSafeInteger(details.result.evidenceCount) || details.result.evidenceCount < 0)) throw new Error("invalid_request");
  if (details?.delivery && Object.keys(details.delivery).some((key) => !["deliveryKey", "segment", "status", "receiptRef", "bindingRef"].includes(key))) throw new Error("invalid_request");
  if (details?.delivery?.bindingRef !== undefined && (typeof details.delivery.bindingRef !== "string" || !/^[a-f0-9]{64}$/.test(details.delivery.bindingRef))) throw new Error("invalid_request");
  if (details?.delivery?.receiptRef !== undefined && !/^[a-f0-9]{64}$/.test(details.delivery.receiptRef)) throw new Error("invalid_request");
  return { schemaVersion: 1, occurredAt, principalRef: context.principalRef, role: action === "authorization.denied" ? "unresolved" : context.auditRole ?? "requester",
    tenantRef: context.tenantRef, destinationRef: context.destinationRef, caseRef: context.caseRef, phaseId: context.phaseId, callId: context.callId, operationId: context.operationRef ?? context.callId,
    resourceRefs: context.resourceRefs, policyVersion: context.policyVersion, approvalRef: context.approvalRef, snapshotRef: context.snapshotRef,
    toolSchemaVersion: tool?.schemaVersion ?? "mock-schema-1", artifactVersion: tool?.artifactVersion ?? "offline-simulator-1",
    sanitizationVersion: tool?.sanitizationVersion ?? "mock-sanitization-1", sanitizationStatus: "validated_metadata",
    ...(tool ? { toolName: tool.name, manifestSha256: tool.manifestSha256 } : {}),
    ...(model ? { model: { ...model } } : {}),
    authorization: { decision: action === "authorization.denied" ? "denied" : "allowed", reason: action === "authorization.denied" ? "denied" : "policy_allowed" },
    scope: scope ?? {}, ...(details?.result ? { result: details.result } : {}), ...(details?.delivery ? { delivery: details.delivery } : {}),
    ...(cost ? { settlement: { source: cost.source, state: cost.actual === null ? "unknown" : "settled", reservedMicrousd: cost.reserved, actualMicrousd: cost.actual } } : {}),
    action, stage, outcome };
}
