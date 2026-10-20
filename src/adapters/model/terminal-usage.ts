import type { UsageSource } from "../../troubleshooting/application/model-budget.js";
import { ModelFailure } from "../../troubleshooting/application/model-failure.js";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
type TerminalStatus = "completed" | "incomplete" | "failed";

export function terminalUsage(event: unknown): { readonly status: TerminalStatus; readonly actualMicrousd: number | null; readonly source: UsageSource } | null {
  if (!object(event)) return null;
  const status = event.type === "response.completed" ? "completed" : event.type === "response.incomplete" ? "incomplete" : event.type === "response.failed" ? "failed" : undefined;
  if (!status) return null;
  if (!object(event.response) || event.response.status !== status) throw new ModelFailure("schema_mismatch");
  const usage = event.response.usage;
  if (!object(usage) || !["mock_usage", "estimated"].includes(String(usage.synthetic_source))) return { status, actualMicrousd: null, source: "unknown" };
  if (!Number.isSafeInteger(usage.synthetic_cost_microusd) || Number(usage.synthetic_cost_microusd) < 0) throw new ModelFailure("schema_mismatch", "ended");
  // These fields are defined only by the reviewed local synthetic contract, never actual billing.
  return { status, actualMicrousd: Number(usage.synthetic_cost_microusd), source: usage.synthetic_source as "mock_usage" | "estimated" };
}
