import type { CallContext, Ports } from "./ports.js";

/** Owns real execution, independently of the caller's bounded wait or the case's business state. */
export class PhaseExecution {
  private readonly work = new Set<Promise<unknown>>();
  private aborting?: Promise<void>;
  private closing?: Promise<void>;
  private stopping?: Promise<void>;
  private outcome: "open" | "closing" | "closed" | "failed" = "open";
  private activated = false;

  constructor(readonly context: CallContext, readonly controller: AbortController, private readonly agent: Ports["agent"],
    private readonly changed: () => void, private readonly settled: (execution: PhaseExecution) => void) {}

  get closed(): boolean { return this.outcome === "closed" && this.work.size === 0; }
  get failed(): boolean { return this.outcome === "failed"; }

  activate(): void { if (this.outcome !== "open") throw new Error("cancelled"); this.activated = true; }

  // A producer may add children while closing. A closed owner is sealed before any factory can start work.
  produce<T>(operation: () => Promise<T>): Promise<T> {
    if (this.outcome !== "open") throw new Error("cancelled");
    return this.run(operation);
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.outcome === "closed" || this.outcome === "failed") throw new Error("cancelled");
    const task = operation();
    this.work.add(task);
    const ended = () => { this.work.delete(task); this.changed(); };
    void task.then(ended, ended);
    return task;
  }

  abort(): Promise<void> {
    this.controller.abort();
    if (this.outcome === "closed" || this.outcome === "failed") return this.closing ?? Promise.resolve();
    return this.aborting ??= this.run(async () => { if (this.activated) await this.agent.abort(this.context.caseRef, this.context.phaseId); });
  }

  stop(wait: () => Promise<void>): Promise<void> { return this.stopping ??= wait(); }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.outcome = "closing";
    return this.closing = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.activated ? this.agent.close(this.context.caseRef, this.context.phaseId) : undefined),
        (async () => { while (this.work.size) await Promise.allSettled([...this.work]); })(),
      ]);
      // Children (including abort) can be registered by a still-running producer after close began.
      let abort: PromiseSettledResult<void | undefined>[];
      for (;;) {
        while (this.work.size) await Promise.allSettled([...this.work]);
        const originalAbort = this.aborting;
        abort = await Promise.allSettled([originalAbort]);
        if (!this.work.size && originalAbort === this.aborting) break;
      }
      this.outcome = [...results, ...abort].some((result) => result.status === "rejected") ? "failed" : "closed";
      this.settled(this); this.changed();
      if (this.failed) throw new Error("unavailable");
    })();
  }
}

/** Keeps ownership before admission creates a case and after a local wait has expired. */
export class HostExecutions {
  private readonly work = new Set<Promise<unknown>>();
  private readonly phases = new Set<PhaseExecution>();

  create(context: CallContext, controller: AbortController, agent: Ports["agent"], changed: () => void): PhaseExecution {
    const phase = new PhaseExecution(context, controller, agent, changed, (execution) => {
      if (!execution.failed) this.phases.delete(execution);
    });
    this.phases.add(phase);
    return phase;
  }

  track<T>(task: Promise<T>): Promise<T> {
    this.work.add(task);
    const ended = () => { this.work.delete(task); };
    void task.then(ended, ended);
    return task;
  }

  async close(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
    const results = await Promise.allSettled([...this.phases].map((phase) => phase.close()));
    if (results.some((result) => result.status === "rejected") || [...this.phases].some((phase) => phase.failed)) throw new Error("unavailable");
  }
}
