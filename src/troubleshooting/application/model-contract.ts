import type { UsageSource } from "./model-budget.js";

export interface ModelPolicy {
  readonly protocol: string;
  readonly tokenizer: string;
  readonly transformation: string;
  readonly reasoning: string;
  readonly hiddenAttempts: number;
  readonly inputLimit: number;
  readonly outputLimit: number;
}
export interface ModelEnvelope {
  readonly protocol: string;
  readonly tokenizer: string;
  readonly canonicalInput: string;
  readonly inputTokensUpperBound: number;
  readonly maxOutputTokens: number;
  readonly includesReasoning: true;
  readonly hiddenRetries: 0;
  readonly planning: { readonly snapshotRef: string; readonly inputCategory: string; readonly inputMicrousdPerMillion: number;
    readonly outputMicrousdPerMillion: number; readonly reservationMicrousd: number };
}
export interface ModelResponse {
  readonly candidate: unknown;
  readonly actualMicrousd: number | null;
  readonly usageSource?: UsageSource;
  readonly reasoning?: string;
}
