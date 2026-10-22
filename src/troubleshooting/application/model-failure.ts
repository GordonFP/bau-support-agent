import type { UsageSource } from "./model-budget.js";

export class ModelFailure extends Error {
  constructor(readonly kind: "transient_network" | "denied" | "contract_unverified" | "schema_mismatch" | "invalid_request" | "cancelled" | "timeout" | "budget_exhausted", readonly execution: "ended" | "unknown" = "unknown",
    readonly charge?: { readonly actualMicrousd: number; readonly source: UsageSource }) {
    super(kind === "transient_network" ? "unavailable" : kind);
  }
}
