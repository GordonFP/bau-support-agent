import type { Completeness, DiagnosticReport, EvidenceReference, SimulatorObservation } from "../domain/simulator.js";
import type { AuditDetails, CaseRecords, InitialCase, RecordGrant, RecordRole, SavedContext } from "./records.js";
import type { BudgetSettlement, BudgetStatus } from "./model-budget.js";
import type { BeforeModelSend, ModelResponse, ModelTurn } from "./model-contract.js";

import type { Retention } from "./retention.js";

export type SafeReason = "denied" | "invalid_request" | "contract_unverified" | "schema_mismatch" |
  "unavailable" | "timeout" | "cancelled" | "rate_limited" | "budget_exhausted" | "version_unknown" |
  "version_mismatch" | "unsafe_content" | "audit_unavailable" | "interrupted";

export interface VerifiedInbound {
  readonly eventRef: string;
  readonly principalRef: string;
  readonly tenantRef: string;
  readonly destinationRef: string;
  readonly conversationKind: "private" | "group";
  readonly receivedAt: string;
  readonly input: { readonly applicationId?: string; readonly customerId?: string; readonly question: string };
}

export type TrustedActor = Pick<VerifiedInbound, "principalRef" | "tenantRef" | "destinationRef">;

export interface CallContext {
  readonly caseRef: string;
  readonly phaseId: number;
  readonly callId: string;
  readonly operationRef?: string;
  readonly auditRole?: RecordRole | "lifecycle";
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
  readonly state: "investigating" | "awaiting_input" | "completed" | "stopped";
  readonly receivedAt: string;
  readonly acceptedAt: string;
  readonly phaseStartedAt: string;
  readonly deadlineAt?: string;
  readonly waitingStartedAt?: string;
  readonly question?: InformationQuestion;
  readonly reportRef?: string;
  readonly stopReason?: SafeReason;
  readonly deliveryStatus: "pending" | "delivered" | "unknown" | "failed";
  readonly usage: { readonly modelAttempts: number; readonly logRecords: number; readonly logCoverageMs: number };
  readonly elapsedMs: number;
  readonly phases: readonly { readonly phaseId: number; readonly startedAt: string; readonly endedAt?: string;
    readonly outcome?: "awaiting_input" | "completed" | "stopped" }[];
  readonly inputWaits: readonly { readonly questionId: string; readonly startedAt: string; readonly endedAt?: string;
    readonly replyEventRef?: string; readonly replyReceivedAt?: string }[];
}

export interface InformationQuestion {
  readonly questionId: string;
  readonly requiredFields: readonly ["submittedAt"];
  readonly candidates: readonly { readonly candidateRef: string; readonly submittedAt: string }[];
  readonly format: "ISO-8601 UTC";
  readonly prompt: string;
}

export interface ApplicationCandidates {
  readonly kind: "application_candidates";
  readonly customerRef: string;
  readonly candidates: readonly { readonly applicationId: string; readonly submittedAt: string }[];
}

export interface InformationReply {
  readonly principalRef: string;
  readonly tenantRef: string;
  readonly destinationRef: string;
  readonly eventRef: string;
  readonly receivedAt: string;
  readonly reply: { readonly caseRef: string; readonly questionId: string };
  readonly content: Readonly<Record<string, unknown>>;
}

export type InformationResult = { readonly status: "resumed" | "needs_information" | "duplicate" | "terminal"; readonly view: CaseView; readonly newCaseRequired?: true } |
  { readonly status: "denied"; readonly reason: SafeReason; readonly newCaseRequired?: true };

export type Acceptance = { readonly status: "accepted" | "duplicate"; readonly view: CaseView } |
  { readonly status: "denied" | "service_unavailable"; readonly reason: SafeReason };

export interface LogQuery {
  readonly sourceRef: "simulator-source";
  readonly applicationId?: string;
  readonly customerId?: string;
  readonly from: string;
  readonly to: string;
  readonly pageSize: 100;
}
export type SourceEvidence = Omit<EvidenceReference, "evidenceRef" | "caseRef" | "auditRef" | "sanitizationVersion">;
export interface CodeSearchQuery {
  readonly repositoryRef: string;
  readonly snapshotRef: string;
  readonly term?: string;
  readonly kind?: "source" | "symbol";
}
export interface CodeSnippetQuery {
  readonly repositoryRef: string;
  readonly snapshotRef: string;
  readonly symbol: string;
  readonly file: string;
}
export interface CodeTraceQuery extends CodeSnippetQuery {
  readonly direction: "inbound" | "outbound";
  readonly targetRepositoryRef?: string;
}
export interface ReadResult<T> {
  readonly value: T;
  readonly evidence: readonly SourceEvidence[];
  readonly completeness: Completeness;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}
export interface RuntimeRequest {
  readonly question: string;
  readonly progress: (value: unknown) => void;
  readonly invoke: (tool: string, query: unknown) => Promise<unknown>;
  readonly generate: (turn: ModelTurn) => Promise<ModelResponse>;
  readonly diagnose: () => DiagnosticReport;
}
export interface Ports {
  readonly retention?: Retention;
  readonly records: CaseRecords;
  readonly admission: {
    lookup?(key: string): Promise<{ readonly caseRef: string; readonly principalRef: string } | null>;
    allocateCaseRef?(): string;
    confirm(record: { readonly key: string; readonly caseRef: string; readonly principalRef: string; readonly initial: InitialCase }): Promise<
      { readonly status: "confirmed" } | { readonly status: "duplicate"; readonly caseRef: string; readonly principalRef: string; readonly view?: CaseView } | { readonly status: "full" }>;
    release(caseRef: string): Promise<void>;
  };
  readonly clock: { now(): number; utc(): string; schedule?(deadline: number, callback: () => void): () => void };
  readonly authorization: { recordGrant?(actor: TrustedActor, owner: SavedContext): Promise<RecordGrant | null>; allows(action: string, context: Pick<CallContext, "principalRef" | "tenantRef" | "destinationRef" | "resourceRefs">): Promise<boolean> };
  readonly sanitization: { sanitize<T>(value: T, caseRef: string): T; safe(value: unknown): boolean; clear(caseRef: string): void };
  readonly audit: { intent(context: CallContext, action: string, details?: AuditDetails): Promise<string>;
    complete(context: CallContext, action: string, outcome: string, details?: AuditDetails): Promise<void> };
  readonly budget: { reserve(context: CallContext, upperBoundMicrousd: number, beforeStart?: () => Promise<void>): Promise<boolean>; settle(context: CallContext, actualMicrousd: number | null, settlement?: BudgetSettlement): Promise<void>; status(caseRef: string): Promise<BudgetStatus> };
  readonly logs: { read(context: CallContext, query: LogQuery): Promise<ReadResult<SimulatorObservation | ApplicationCandidates | null>> };
  readonly code: {
    search(context: CallContext, query: CodeSearchQuery): Promise<ReadResult<null>>;
    snippet(context: CallContext, query: CodeSnippetQuery): Promise<ReadResult<null>>;
    trace(context: CallContext, query: CodeTraceQuery): Promise<ReadResult<null>>;
  };
  readonly agent: { run(context: CallContext, request: RuntimeRequest): Promise<unknown>; abort(caseRef: string, phaseId?: number): Promise<void>; close(caseRef: string, phaseId?: number): Promise<void> };
  readonly model: { generate(context: CallContext, turn: ModelTurn, beforeSend: BeforeModelSend): Promise<ModelResponse> };
  readonly delivery: { send(destinationRef: string, report: DiagnosticReport, deliveryKey: string): Promise<"delivered" | "unknown" | "failed">;
    fault(destinationRef: string, notice: "Investigation stopped because audit storage is unavailable.", deliveryKey: string): Promise<"delivered" | "unknown" | "failed"> };
}
