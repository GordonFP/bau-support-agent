import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelResponse } from "../../troubleshooting/application/model-contract.js";

interface Prices { readonly pricingSource: "cpa_configured" | "openai_official"; readonly pricingRef: string;
  readonly input: number; readonly output: number; readonly cacheRead: number }
// Official Standard/short-context API-equivalent snapshot, checked 2026-10-22:
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// USD/1M: input 2, output 10, cache read 0.10. Not the Codex account's bill.
const official: Prices = Object.freeze({ pricingSource: "openai_official", pricingRef: "openai-gpt-6.1-sol-standard-2026-10-22",
  input: 2_000_000, output: 10_000_000, cacheRead: 100_000 });

export function cpaPocPrices(path = join(homedir(), "Library/Application Support/com.cpa.gui/usage-records/usage.db")): Prices {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true, timeout: 100 });
    // No usage history, account identifiers, client keys or credential tables are read.
    const row = database.prepare(`SELECT prompt_per_1m,completion_per_1m,cache_read_per_1m,
      prompt_configured,completion_configured,cache_read_configured FROM model_prices WHERE model=?`).get("gpt-6.1-sol");
    if (!row || [row.prompt_configured, row.completion_configured, row.cache_read_configured].some((value) => value !== 1)) return official;
    const rates = [row.prompt_per_1m, row.completion_per_1m, row.cache_read_per_1m];
    if (rates.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value * 1_000_000))) return official;
    const input = Number(row.prompt_per_1m) * 1_000_000, output = Number(row.completion_per_1m) * 1_000_000, cacheRead = Number(row.cache_read_per_1m) * 1_000_000;
    return Object.freeze({ pricingSource: "cpa_configured", pricingRef: `cpa-prices-${createHash("sha256").update(JSON.stringify({ input, output, cacheRead })).digest("hex").slice(0, 16)}`,
      input, output, cacheRead });
  } catch { return official; }
  finally { database?.close(); }
}

export function cpaCostEstimate(usage: ModelResponse["tokenUsage"], prices: Prices): ModelResponse["costEstimate"] {
  if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0 ||
    usage.cachedInputTokens !== null && (!Number.isSafeInteger(usage.cachedInputTokens) || usage.cachedInputTokens < 0 || usage.cachedInputTokens > usage.inputTokens) ||
    usage.reasoningTokens !== null && (!Number.isSafeInteger(usage.reasoningTokens) || usage.reasoningTokens < 0 || usage.reasoningTokens > usage.outputTokens)) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  // Output includes reasoning already. Cached input is a subset of input, not an addition.
  const numerator = BigInt(usage.inputTokens - cached) * BigInt(prices.input) + BigInt(cached) * BigInt(prices.cacheRead) + BigInt(usage.outputTokens) * BigInt(prices.output);
  const microusd = Number((numerator + 999_999n) / 1_000_000n);
  if (!Number.isSafeInteger(microusd)) return undefined;
  return { microusd, pricingSource: prices.pricingSource, pricingRef: prices.pricingRef, basis: "standard-api-equivalent" };
}
