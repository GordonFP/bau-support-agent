import type { CallContext, CaseView, TrustedActor, VerifiedInbound } from "./ports.js";

export type SavedContext = Omit<CallContext, "signal" | "deadline" | "callId" | "operationRef">;
export interface InitialCase {
  readonly context: SavedContext;
  readonly view: CaseView;
  readonly input: VerifiedInbound["input"];
}
export interface CaseRecord {
  readonly recordRef: string;
  readonly schemaVersion: 1;
  readonly kind: "input" | "view" | "model_input" | "model_output" | "tool_result" | "evidence" | "report";
  readonly payload: unknown;
}
export interface StoredCase {
  readonly view: CaseView;
  readonly records: readonly CaseRecord[];
  readonly audits: readonly Readonly<Record<string, unknown>>[];
  readonly deliveries: readonly DeliveryRecord[];
}
export interface DeliveryRecord {
  readonly schemaVersion: 1;
  readonly caseRef: string;
  readonly deliveryKey: string;
  readonly segment: number;
  readonly callId: string;
  readonly status: "delivered" | "unknown" | "failed";
}
export interface CaseRecords {
  append(context: CallContext, record: CaseRecord): Promise<void>;
  read(actor: TrustedActor, caseRef: string): Promise<StoredCase | null>;
  export(actor: TrustedActor, caseRef: string): Promise<StoredCase | null>;
}

export interface AuditDetails {
  readonly scope?: { readonly sourceRef?: string; readonly repositoryRef?: string; readonly snapshotRef?: string;
    readonly from?: string; readonly to?: string; readonly pageSize?: number };
  readonly result?: { readonly completeness: "complete" | "partial" | "unknown"; readonly truncated: boolean; readonly evidenceCount: number };
  readonly delivery?: { readonly deliveryKey: string; readonly segment: number; readonly status?: "delivered" | "unknown" | "failed" };
}
