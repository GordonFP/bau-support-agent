import type { TrustedActor } from "./ports.js";

export type RetentionTriggerKind = "mvp_accepted" | "poc_no_go" | "terminated" | "no_mvp";
export interface RetentionTrigger {
  readonly triggerRef: string;
  readonly kind: RetentionTriggerKind;
  readonly decidedAt: string;
  readonly scope: "poc";
}
export interface RegisteredTrigger extends RetentionTrigger {
  readonly dueAt: string;
  readonly registeredAt: string;
}
export interface DeletionCheck {
  readonly scope: string;
  readonly result: "deleted" | "failed";
  readonly verification: string;
}
export interface DeletionReceipt {
  readonly receiptRef: string;
  readonly scope: "poc";
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly result: "deleted" | "partial";
  readonly checks: readonly DeletionCheck[];
  readonly retained: readonly string[];
  readonly limits: readonly string[];
}
export interface RetentionStatus {
  readonly scope: "poc";
  readonly state: "untriggered" | "scheduled" | "deleting" | "partial" | "deleted";
  readonly triggers: readonly RegisteredTrigger[];
  readonly dueAt?: string;
  readonly closedAt?: string;
  readonly receipt?: DeletionReceipt;
}
export interface Retention {
  recordTrigger(actor: TrustedActor, trigger: RetentionTrigger): Promise<RetentionStatus>;
  purgeDue(actor: TrustedActor): Promise<RetentionStatus>;
  deletionStatus(actor: TrustedActor): Promise<RetentionStatus>;
  // Host-only runtime gate and cleanup notification; never registered as Agent tools.
  closed(): boolean;
  recordDeniedAccess(actor: TrustedActor, action: string): void;
  onClose(handler: () => Promise<void>): void;
}
