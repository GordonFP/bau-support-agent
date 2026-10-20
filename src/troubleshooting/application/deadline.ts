import type { Ports } from "./ports.js";

export function schedule(clock: Ports["clock"], deadline: number, callback: () => void): () => void {
  if (clock.schedule) return clock.schedule(deadline, callback);
  const timer = setTimeout(callback, Math.max(0, deadline - clock.now()));
  timer.unref();
  return () => clearTimeout(timer);
}

// Local waiting ends at the deadline; the original promise remains observed until it settles.
export function beforeDeadline<T>(clock: Ports["clock"], deadline: number, operation: () => Promise<T>,
  signal?: AbortSignal, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (clock.now() >= deadline) { reject(new Error("timeout")); return; }
    if (signal?.aborted) { reject(new Error("cancelled")); return; }
    let done = false;
    const complete = (result: { value: T } | { error: unknown }) => {
      if (done) return;
      done = true;
      cancelTimer();
      signal?.removeEventListener("abort", abort);
      if ("value" in result) resolve(result.value); else reject(result.error);
    };
    const abort = () => complete({ error: new Error("cancelled") });
    const cancelTimer = schedule(clock, deadline, () => {
      complete({ error: new Error("timeout") });
      onTimeout?.();
    });
    signal?.addEventListener("abort", abort, { once: true });
    try { operation().then((value) => complete({ value }), (error: unknown) => complete({ error })); }
    catch (error) { complete({ error }); }
  });
}
