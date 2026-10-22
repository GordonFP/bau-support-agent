import { MODEL_INPUT_TOKENS, MODEL_OUTPUT_TOKENS } from "./limits.js";

// Approved planning snapshot; these are not company contract rates or real-route proof.
export const publicPricing = Object.freeze({ snapshotRef: "public-pricing-2026-10-20", currency: "USD", unit: "microusd-per-million-tokens",
  sources: Object.freeze(["https://azure.microsoft.com/en-us/pricing/details/azure-openai/",
    "https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/deepseek/"]),
  gptShort: Object.freeze({ input: 2_000_000, cacheRead: 100_000, cacheWrite: 2_500_000, output: 10_000_000 }),
  gptLong: Object.freeze({ input: 4_000_000, cacheRead: 200_000, cacheWrite: 5_000_000, output: 15_000_000 }),
  deepseekFlash: Object.freeze({ input: 190_000, cacheRead: 28_000, cacheWrite: null, output: 510_000 }),
  unknown: Object.freeze(["gpt-short-long-threshold", "model-alias-mapping", "company-sku-region", "gateway-surcharge-tax", "deepseek-cache-write"]) });

export function modelPlanning() {
  const inputRate = Math.max(publicPricing.gptLong.input, publicPricing.gptLong.cacheWrite);
  const outputRate = publicPricing.gptLong.output;
  const numerator = BigInt(MODEL_INPUT_TOKENS) * BigInt(inputRate) + BigInt(MODEL_OUTPUT_TOKENS) * BigInt(outputRate);
  return Object.freeze({ snapshotRef: publicPricing.snapshotRef, inputCategory: "long-write-upper-bound",
    inputMicrousdPerMillion: inputRate, outputMicrousdPerMillion: outputRate, reservationMicrousd: Number((numerator + 999_999n) / 1_000_000n) });
}

// Output observation is an owner-approved synthetic POC exception. This reservation
// is an estimate for admission accounting, not a proven maximum bill or free usage.
export function cpaPocPlanning() {
  return Object.freeze({ ...modelPlanning(), snapshotRef: "cpa-poc-planning-2026-10-22", inputCategory: "estimate-without-output-bound" });
}
