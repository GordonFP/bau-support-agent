import type { UsageSource } from "../../troubleshooting/application/model-budget.js";
import { ModelFailure } from "../../troubleshooting/application/model-failure.js";
import type { ModelResponse } from "../../troubleshooting/application/model-contract.js";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
type TerminalStatus = "completed" | "incomplete" | "failed";

export function terminalUsage(event: unknown, cpaPoc = false): { readonly status: TerminalStatus; readonly actualMicrousd: number | null; readonly source: UsageSource;
  readonly tokenUsage?: ModelResponse["tokenUsage"] } | null {
  if (!object(event)) return null;
  const status = event.type === "response.completed" ? "completed" : event.type === "response.incomplete" ? "incomplete" : event.type === "response.failed" ? "failed" : undefined;
  if (!status) return null;
  if (!object(event.response) || event.response.status !== status) throw new ModelFailure("schema_mismatch");
  const usage = event.response.usage;
  if (cpaPoc) {
    if (event.response.model !== "gpt-6.1-sol") throw new ModelFailure("contract_unverified", "ended");
    const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
    if (!object(usage) || !count(usage.input_tokens) || !count(usage.output_tokens)) return { status, actualMicrousd: null, source: "unknown" };
    const reasoning = object(usage.output_tokens_details) ? usage.output_tokens_details.reasoning_tokens : null;
    const cached = object(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : null;
    return { status, actualMicrousd: null, source: "unknown", tokenUsage: { source: "upstream_tokens", inputTokens: Number(usage.input_tokens), outputTokens: Number(usage.output_tokens),
      reasoningTokens: count(reasoning) ? Number(reasoning) : null, cachedInputTokens: count(cached) ? Number(cached) : null } };
  }
  if (!object(usage) || !["mock_usage", "estimated"].includes(String(usage.synthetic_source))) return { status, actualMicrousd: null, source: "unknown" };
  if (!Number.isSafeInteger(usage.synthetic_cost_microusd) || Number(usage.synthetic_cost_microusd) < 0) throw new ModelFailure("schema_mismatch", "ended");
  // These fields are defined only by the reviewed local synthetic contract, never actual billing.
  return { status, actualMicrousd: Number(usage.synthetic_cost_microusd), source: usage.synthetic_source as "mock_usage" | "estimated" };
}
