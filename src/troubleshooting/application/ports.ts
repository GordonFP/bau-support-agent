import type { Completeness, DiagnosticReport, EvidenceReference, SimulatorObservation } from "../domain/simulator.js";

export type SafeReason = "denied" | "invalid_request" | "contract_unverified" | "schema_mismatch" |
  "unavailable" | "timeout" | "cancelled" | "rate_limited" | "budget_exhausted" | "version_unknown" |
  "version_mismatch" | "unsafe_content" | "audit_unavailable";

export interface VerifiedInbound {
  readonly eventRef: string;
  readonly principalRef: string;
  readonly tenantRef: string;
  readonly destinationRef: string;
  readonly conversationKind: "private" | "group";
  readonly receivedAt: string;
  readonly input: { readonly applicationId: string; readonly question: string };
}

export interface CallContext {
  readonly caseRef: string;
  readonly phaseId: number;
  readonly callId: string;
  readonly principalRef: string;
  readonly tenantRef: string;
  readonly destinationRef: string;
  readonly policyVersion: string;
  readonly approvalRef: string;
  readonly resourceRefs: readonly string[];
  readonly snapshotRef: string;
  readonly budgetRef: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
}

export interface CaseView {
  readonly caseRef: string;
  readonly phaseId: number;
  readonly state: "investigating" | "completed" | "stopped";
  readonly receivedAt: string;
  readonly acceptedAt: string;
  readonly phaseStartedAt: string;
  readonly deadlineAt: string;
  readonly reportRef?: string;
  readonly stopReason?: SafeReason;
  readonly deliveryStatus: "pending" | "delivered" | "unknown" | "failed";
}

export type Acceptance = { readonly status: "accepted" | "duplicate"; readonly view: CaseView } |
  { readonly status: "denied" | "service_unavailable"; readonly reason: SafeReason };

export interface LogQuery {
  readonly sourceRef: "simulator-source";
  readonly applicationId: string;
  readonly from: string;
  readonly to: string;
  readonly pageSize: 100;
}
export type SourceEvidence = Omit<EvidenceReference, "evidenceRef" | "caseRef" | "auditRef" | "sanitizationVersion">;
export interface ReadResult<T> {
  readonly value: T;
  readonly evidence: readonly SourceEvidence[];
  readonly completeness: Completeness;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}
export interface RuntimeRequest {
  readonly question: string;
  readonly invoke: (tool: string, query: unknown) => Promise<unknown>;
  readonly generate: (draft: DiagnosticReport) => Promise<unknown>;
  readonly diagnose: () => DiagnosticReport;
}
export interface Ports {
  readonly clock: { now(): number; utc(): string };
  readonly authorization: { allows(action: string, context: Pick<CallContext, "principalRef" | "tenantRef" | "destinationRef" | "resourceRefs">): Promise<boolean> };
  readonly sanitization: { sanitize<T>(value: T, caseRef: string): T; safe(value: unknown): boolean; clear(caseRef: string): void };
  readonly audit: { intent(context: CallContext, action: string): Promise<string>; complete(context: CallContext, action: string, outcome: string): Promise<void> };
  readonly budget: { reserve(context: CallContext, upperBoundMicrousd: number): Promise<boolean>; settle(context: CallContext, actualMicrousd: number | null): Promise<void>; status(caseRef: string): Promise<{ reservedMicrousd: number }> };
  readonly logs: { read(context: CallContext, query: LogQuery): Promise<ReadResult<SimulatorObservation | null>> };
  readonly code: { search(context: CallContext, query: { readonly repositoryRef: string; readonly snapshotRef: string }): Promise<ReadResult<null>> };
  readonly agent: { run(context: CallContext, request: RuntimeRequest): Promise<unknown>; abort(caseRef: string): Promise<void>; close(caseRef: string): Promise<void> };
  readonly model: { generate(context: CallContext, draft: DiagnosticReport): Promise<{ readonly candidate: unknown; readonly actualMicrousd: number | null }> };
  readonly delivery: { send(destinationRef: string, report: DiagnosticReport, deliveryKey: string): Promise<"delivered" | "unknown" | "failed"> };
}
