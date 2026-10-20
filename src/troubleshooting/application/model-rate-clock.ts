import type { Ports } from "./ports.js";

// Persisted logical time advances only by this process's injected monotonic clock.
// Downtime has no trusted monotonic duration, so restart conservatively pauses the window.
export class ModelRateClock {
  private readonly started: number;
  private last: number;

  constructor(private readonly clock: Ports["clock"], private readonly base = 0) {
    this.started = clock.now();
    this.last = base;
    if (!Number.isFinite(this.started) || !Number.isSafeInteger(base) || base < 0) throw new Error("invalid_request");
  }

  now(): number {
    const value = this.base + Math.max(0, Math.floor(this.clock.now() - this.started));
    if (!Number.isSafeInteger(value)) throw new Error("invalid_request");
    return this.last = Math.max(this.last, value);
  }
}
