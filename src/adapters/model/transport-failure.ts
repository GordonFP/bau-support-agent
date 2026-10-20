import { ModelFailure } from "../../troubleshooting/application/model-failure.js";

const safeReasons = new Set(["denied", "invalid_request", "contract_unverified", "schema_mismatch", "unavailable", "timeout", "cancelled",
  "rate_limited", "budget_exhausted", "unsafe_content", "audit_unavailable"]);
const transientCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

export function transportFailure(error: unknown, dispatched: boolean, signal: AbortSignal): Error {
  if (error instanceof ModelFailure) return error;
  if (!dispatched && error instanceof Error && safeReasons.has(error.message)) return error;
  if (signal.aborted) return new Error("cancelled");
  const causes = [error, error instanceof Error ? error.cause : undefined];
  if (dispatched && causes.some((value) => value && typeof value === "object" && "code" in value && transientCodes.has(String(value.code))))
    return new ModelFailure("transient_network");
  return new Error("unavailable");
}
