import type { UsageSource } from "../../troubleshooting/application/model-budget.js";
import { ModelFailure } from "../../troubleshooting/application/model-failure.js";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function terminalUsage(event: unknown): { readonly actualMicrousd: number | null; readonly source: UsageSource } | null {
  if (!object(event) || !["response.completed", "response.incomplete", "response.failed"].includes(String(event.type)) || !object(event.response) ||
    !["completed", "incomplete", "failed"].includes(String(event.response.status))) return null;
  const usage = event.response.usage;
  if (!object(usage) || !["mock_usage", "estimated"].includes(String(usage.synthetic_source))) return { actualMicrousd: null, source: "unknown" };
  if (!Number.isSafeInteger(usage.synthetic_cost_microusd) || Number(usage.synthetic_cost_microusd) < 0) throw new ModelFailure("schema_mismatch", "ended");
  // These fields are defined only by the reviewed local synthetic contract, never actual billing.
  return { actualMicrousd: Number(usage.synthetic_cost_microusd), source: usage.synthetic_source as "mock_usage" | "estimated" };
}
