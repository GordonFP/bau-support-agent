import type { CallContext, CaseView } from "./ports.js";
import type { CaseRecord, SavedContext } from "./records.js";

export function savedContextSnapshot(value: SavedContext): SavedContext {
  return Object.freeze({ caseRef: value.caseRef, phaseId: value.phaseId, principalRef: value.principalRef, tenantRef: value.tenantRef,
    destinationRef: value.destinationRef, policyVersion: value.policyVersion, approvalRef: value.approvalRef,
    resourceRefs: Object.freeze([...value.resourceRefs]), snapshotRef: value.snapshotRef, budgetRef: value.budgetRef });
}

export function contextSnapshot(value: CallContext): CallContext {
  return Object.freeze({ ...savedContextSnapshot(value), callId: value.callId, ...(value.operationRef ? { operationRef: value.operationRef } : {}), deadline: value.deadline, signal: value.signal });
}

export function sameCaseAuthority(actual: SavedContext, expected: SavedContext): boolean {
  return ["caseRef", "principalRef", "tenantRef", "destinationRef", "policyVersion", "approvalRef", "snapshotRef", "budgetRef"]
    .every((key) => actual[key as keyof SavedContext] === expected[key as keyof SavedContext]) &&
    JSON.stringify(actual.resourceRefs) === JSON.stringify(expected.resourceRefs);
}

export function recordSnapshot(context: CallContext, value: CaseRecord): CaseRecord {
  let record: CaseRecord;
  try { record = structuredClone(value); } catch { throw new Error("invalid_request"); }
  if (record.schemaVersion !== 1 || !["input", "view", "model_input", "model_output", "tool_result", "evidence", "report"].includes(record.kind) ||
    typeof record.recordRef !== "string" || record.recordRef.length > 512 || !record.recordRef.startsWith(`${context.caseRef}:`) || record.payload === undefined) throw new Error("invalid_request");
  if (record.kind === "view") {
    const view = record.payload as CaseView;
    if (!view || view.caseRef !== context.caseRef || view.phaseId !== context.phaseId || !Number.isSafeInteger(view.phaseId) || view.phaseId < 1 ||
      !["investigating", "awaiting_input", "completed", "stopped"].includes(view.state) || !view.usage ||
      ![view.usage.modelAttempts, view.usage.logRecords, view.usage.logCoverageMs].every((count) => Number.isSafeInteger(count) && count >= 0) ||
      !Number.isFinite(view.elapsedMs) || view.elapsedMs < 0) throw new Error("invalid_request");
  }
  return record;
}

export function advancesView(current: CaseView, next: CaseView): boolean {
  if (current.state === "completed" || current.state === "stopped" || next.phaseId < current.phaseId) return false;
  if (current.phaseId === next.phaseId && current.state === "awaiting_input" && next.state === "investigating") return false;
  return next.elapsedMs >= current.elapsedMs && next.usage.modelAttempts >= current.usage.modelAttempts &&
    next.usage.logRecords >= current.usage.logRecords && next.usage.logCoverageMs >= current.usage.logCoverageMs;
}
