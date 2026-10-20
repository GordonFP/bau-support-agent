import type { CallContext, Ports } from "./ports.js";
import { contextSnapshot } from "./record-contract.js";
import { modelCallBinding } from "./model-budget.js";
import { MAX_ACTIVE_CASES } from "./limits.js";
import { beforeDeadline, schedule } from "./deadline.js";

export class ModelBudgetQueue {
  private readonly queued = new Map<string, { context: CallContext; amount: number; operation: Promise<boolean> }>();
  private readonly waiters = new Set<() => void>();
  private closed = false;

  constructor(private readonly clock: Ports["clock"], private readonly rateNow: () => number,
    private readonly admit: (context: CallContext, amount: number) => boolean | number) {}

  async reserve(context: CallContext, amount: number, beforeStart?: () => Promise<void>): Promise<boolean> {
    context = contextSnapshot(context);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("invalid_request");
    const previous = this.queued.get(context.callId);
    if (previous) return previous.amount === amount && modelCallBinding(previous.context) === modelCallBinding(context) ? previous.operation : false;
    if (this.expired(context)) return false;
    if (this.queued.size >= MAX_ACTIVE_CASES) throw new Error("unavailable");
    // A timed-out caller stops waiting, but an unresolved control still occupies its bounded position.
    const work = this.start(context, amount, beforeStart).finally(() => this.queued.delete(context.callId));
    const operation = beforeDeadline(this.clock, context.deadline, () => work, context.signal).catch((error: unknown) => {
      if (error instanceof Error && ["timeout", "cancelled"].includes(error.message)) return false;
      throw error;
    });
    this.queued.set(context.callId, { context, amount, operation });
    return operation;
  }

  private expired(context: CallContext): boolean {
    return this.closed || context.signal.aborted || this.clock.now() >= context.deadline;
  }

  private async start(context: CallContext, amount: number, beforeStart?: () => Promise<void>): Promise<boolean> {
    while (!this.expired(context)) {
      await beforeStart?.();
      if (this.expired(context)) return false;
      const admitted = this.admit(context, amount);
      if (typeof admitted === "boolean") return admitted;
      await new Promise<void>((resolve) => {
        const done = () => { cancel(); context.signal.removeEventListener("abort", done); this.waiters.delete(done); resolve(); };
        const wakeAt = Math.min(context.deadline, this.clock.now() + Math.max(0, admitted - this.rateNow()));
        const cancel = schedule(this.clock, wakeAt, done);
        this.waiters.add(done);
        context.signal.addEventListener("abort", done, { once: true });
      });
    }
    return false;
  }

  changed(): void { for (const waiter of [...this.waiters]) waiter(); }
  close(): void { this.closed = true; this.changed(); }
}
