import type { UsageSource } from "./model-budget.js";

export type ModelJson = null | boolean | number | string | readonly ModelJson[] | { readonly [key: string]: ModelJson };
export type ModelContent = { readonly type: "text"; readonly text: string } |
  { readonly type: "toolCall"; readonly id: string; readonly name: "logs_read" | "code_search"; readonly arguments: { readonly [key: string]: ModelJson } };
export interface ModelTool {
  readonly name: "logs_read" | "code_search";
  readonly description: string;
  readonly parameters: { readonly type: "object"; readonly properties: Readonly<Record<string, never>>; readonly additionalProperties: false };
}
export type ModelMessage = { readonly role: "system"; readonly content: string; readonly sections?: Readonly<Record<string, string | null>>;
  readonly toolsAdded?: readonly ModelTool[]; readonly toolsRemoved?: readonly string[] } |
  { readonly role: "user"; readonly content: string } |
  { readonly role: "assistant"; readonly content: readonly ModelContent[] } |
  { readonly role: "toolResult"; readonly toolCallId: string; readonly toolName: "logs_read" | "code_search"; readonly content: string; readonly isError: boolean };
export interface ModelTurn { readonly schemaVersion: 1; readonly messages: readonly ModelMessage[] }
export interface ModelAssistant { readonly content: readonly ModelContent[]; readonly stopReason: "stop" | "toolUse" }
export type BeforeModelSend = (request: ModelEnvelope) => Promise<void>;

export interface ModelPolicy {
  readonly protocol: string;
  readonly tokenizer: string;
  readonly transformation: string;
  readonly reasoning: string;
  readonly hiddenAttempts: number;
  readonly inputLimit: number;
  readonly outputLimit: number | null;
}
export interface ModelEnvelope {
  readonly profile: "memory_mock" | "local_protocol" | "cpa_poc";
  readonly turnRef: string;
  readonly protocol: string;
  readonly tokenizer: string;
  readonly canonicalInput: string;
  readonly inputTokensUpperBound: number;
  readonly maxOutputTokens: number | null;
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
  readonly tokenUsage?: { readonly source: "upstream_tokens"; readonly inputTokens: number; readonly outputTokens: number;
    readonly reasoningTokens: number | null; readonly cachedInputTokens: number | null };
  readonly costEstimate?: { readonly microusd: number; readonly pricingSource: "cpa_configured" | "openai_official";
    readonly pricingRef: string; readonly basis: "standard-api-equivalent" };
  readonly message: ModelAssistant;
}
