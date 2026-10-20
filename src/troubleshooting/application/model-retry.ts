import type { Ports } from "./ports.js";
import { MAX_TRANSIENT_NETWORK_RETRIES, MODEL_CALL_MS } from "./limits.js";
import { ModelFailure } from "./model-failure.js";

export async function retryModel<T>(clock: Ports["clock"], phaseDeadline: number, nextCallId: () => string,
  execute: (identity: { callId: string; operationRef: string; deadline: number; retryable: boolean }) => Promise<T>): Promise<T> {
  const operationRef = nextCallId();
  const deadline = Math.min(phaseDeadline, clock.now() + MODEL_CALL_MS);
  for (let attempt = 0; attempt <= MAX_TRANSIENT_NETWORK_RETRIES; attempt++) {
    if (clock.now() >= deadline) throw new Error("timeout");
    try { return await execute({ callId: attempt === 0 ? operationRef : nextCallId(), operationRef, deadline, retryable: attempt === 0 }); }
    catch (error) { if (!(error instanceof ModelFailure) || error.kind !== "transient_network" || attempt !== 0) throw error; }
  }
  throw new Error("unavailable");
}
