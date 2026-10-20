import type { CallContext } from "./ports.js";
import { savedContextSnapshot } from "./record-contract.js";

export type UsageSource = "mock_usage" | "upstream_usage" | "estimated" | "unknown";
export interface BudgetSettlement {
  readonly execution: "ended" | "unknown";
  readonly source: UsageSource;
}
export interface BudgetCharge {
  readonly callId: string;
  readonly reservedMicrousd: number;
  readonly actualMicrousd: number | null;
  readonly estimatedMicrousd: number | null;
  readonly source: string;
  readonly execution: "ended" | "unknown";
}
export interface BudgetStatus {
  readonly reservedMicrousd: number;
  readonly pocMicrousd: number;
  readonly attempts: number;
  readonly unsettledCalls: number;
  readonly startsLast60s: number;
  readonly charges: readonly BudgetCharge[];
  readonly contractViolated: boolean;
}

export function reconcileCharge(previous: { actual: number | null; estimated: number | null; source: string; ended: boolean },
  amount: number | null, settlement?: BudgetSettlement) {
  if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) throw new Error("invalid_request");
  if (settlement && (Object.keys(settlement).some((key) => !["execution", "source"].includes(key)) ||
    !["ended", "unknown"].includes(settlement.execution) || !["mock_usage", "upstream_usage", "estimated", "unknown"].includes(settlement.source))) throw new Error("invalid_request");
  const source = settlement?.source ?? (amount !== null && amount > 0 ? "mock_usage" : "unknown");
  const known = amount !== null && ["mock_usage", "upstream_usage"].includes(source);
  if (previous.actual !== null && known && previous.actual !== amount) throw new Error("invalid_request");
  const estimated = source === "estimated" && amount !== null ? amount : previous.estimated;
  return { actual: previous.actual ?? (known ? amount : null), estimated,
    source: previous.actual !== null ? previous.source : known ? source : estimated !== null ? "estimated" : "unknown",
    ended: previous.ended || settlement?.execution === "ended" || (!settlement && known) };
}
export const modelCallBinding = (context: CallContext) => JSON.stringify({ ...savedContextSnapshot(context), operationRef: context.operationRef ?? context.callId });
