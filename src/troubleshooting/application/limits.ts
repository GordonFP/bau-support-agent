export const CASE_EXECUTION_MS = 180_000;
export const MAX_MODEL_ATTEMPTS = 6;
export const MAX_LOG_RECORDS = 500;
export const MODEL_INPUT_TOKENS = 24_000;
export const MODEL_OUTPUT_TOKENS = 4_000;
export const CASE_MODEL_MICROUSD = 2_000_000;
export const POC_MODEL_MICROUSD = 100_000_000;
export const MAX_MODEL_UNSETTLED = 2;
export const MAX_MODEL_STARTS = 6;
export const MODEL_RATE_WINDOW_MS = 60_000;
export const MAX_TRANSIENT_NETWORK_RETRIES = 1;
export const MAX_ACTIVE_CASES = 32;
export const MAX_INBOUND_BYTES = 65_536;
export const MODEL_CALL_MS = 60_000;
export const TOOL_CALL_MS = 30_000;
export const CLEANUP_MS = 5_000;

export function boundedBody(value: unknown): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_INBOUND_BYTES; } catch { return false; }
}

export function phaseWindow(clock: { now(): number; utc(): string }) {
  const startedAt = clock.utc();
  return { startedAt, deadline: clock.now() + CASE_EXECUTION_MS,
    deadlineAt: new Date(Date.parse(startedAt) + CASE_EXECUTION_MS).toISOString() };
}
