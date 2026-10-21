import type { CallContext, Ports } from "./ports.js";

/** Owns real execution, independently of the caller's bounded wait or the case's business state. */
export class PhaseExecution {
  private readonly work = new Set<Promise<unknown>>();
  private aborting?: Promise<void>;
  private closing?: Promise<void>;
  private stopping?: Promise<void>;
  private outcome: "open" | "closed" | "failed" = "open";

  constructor(readonly context: CallContext, readonly controller: AbortController, private readonly agent: Ports["agent"],
    private readonly changed: () => void, private readonly settled: (execution: PhaseExecution) => void) {}

  get closed(): boolean { return this.outcome === "closed" && this.work.size === 0; }
  get failed(): boolean { return this.outcome === "failed"; }

  track<T>(task: Promise<T>): Promise<T> {
    this.work.add(task);
    const ended = () => { this.work.delete(task); this.changed(); };
    void task.then(ended, ended);
    return task;
  }

  abort(): Promise<void> {
    this.controller.abort();
    return this.aborting ??= this.track(Promise.resolve().then(() => this.agent.abort(this.context.caseRef, this.context.phaseId)));
  }

  stop(wait: () => Promise<void>): Promise<void> { return this.stopping ??= wait(); }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.agent.close(this.context.caseRef, this.context.phaseId)),
        this.aborting,
        (async () => { while (this.work.size) await Promise.allSettled([...this.work]); })(),
      ]);
      this.outcome = results.some((result) => result.status === "rejected") ? "failed" : "closed";
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
