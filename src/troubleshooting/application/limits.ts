export const CASE_EXECUTION_MS = 180_000;
export const MAX_MODEL_ATTEMPTS = 6;
export const MAX_LOG_RECORDS = 500;
export const MODEL_RESERVATION_MICROUSD = 180_000;

export function phaseWindow(clock: { now(): number; utc(): string }) {
  const startedAt = clock.utc();
  return { startedAt, deadline: clock.now() + CASE_EXECUTION_MS,
    deadlineAt: new Date(Date.parse(startedAt) + CASE_EXECUTION_MS).toISOString() };
}
