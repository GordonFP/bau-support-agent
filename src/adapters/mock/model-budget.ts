import type { CallContext, Ports } from "../../troubleshooting/application/ports.js";
import { CASE_MODEL_MICROUSD, MAX_MODEL_ATTEMPTS, MAX_MODEL_STARTS, MAX_MODEL_UNSETTLED, MODEL_RATE_WINDOW_MS, POC_MODEL_MICROUSD } from "../../troubleshooting/application/limits.js";
import { ModelBudgetQueue, type ModelAdmission } from "../../troubleshooting/application/model-budget-queue.js";
import { modelCallBinding, reconcileCharge } from "../../troubleshooting/application/model-budget.js";
import type { BudgetSettlement, BudgetStatus } from "../../troubleshooting/application/model-budget.js";

import { ModelRateClock } from "../../troubleshooting/application/model-rate-clock.js";

interface Charge { caseRef: string; binding: string; reserved: number; actual: number | null; estimated: number | null; source: string; ended: boolean; startedAt: number }

export class MockModelBudget {
  private readonly charges = new Map<string, Charge>();
  private readonly queue: ModelBudgetQueue;
  private readonly rateClock: ModelRateClock;

  constructor(private readonly controls: Pick<Ports, "clock" | "sanitization">) {
    this.rateClock = new ModelRateClock(controls.clock);
    this.queue = new ModelBudgetQueue(controls.clock, () => this.rateClock.now(), (context, amount) => this.admit(context, amount));
  }

  async reserve(context: CallContext, amount: number, beforeStart?: () => Promise<void>): Promise<boolean> {
    if (!this.controls.sanitization.safe({ callId: context.callId, caseRef: context.caseRef })) throw new Error("unsafe_content");
    return this.queue.reserve(context, amount, beforeStart);
  }

  private admit(context: CallContext, amount: number): ModelAdmission {
    const binding = modelCallBinding(context);
    const previous = this.charges.get(context.callId);
    if (previous) return { status: previous.caseRef === context.caseRef && previous.reserved === amount && previous.binding === binding ? "admitted" : "rejected" };
    const all = [...this.charges.values()];
    const own = all.filter((charge) => charge.caseRef === context.caseRef);
    const cost = (values: Charge[]) => values.reduce((total, charge) => total + (charge.actual ?? charge.reserved), 0);
    if (cost(all) + amount > POC_MODEL_MICROUSD || cost(own) + amount > CASE_MODEL_MICROUSD || own.length >= MAX_MODEL_ATTEMPTS ||
      all.some((charge) => charge.actual !== null && charge.actual > charge.reserved)) return { status: "rejected" };
    const now = this.rateClock.now();
    const recent = all.filter((charge) => charge.startedAt > now - MODEL_RATE_WINDOW_MS);
    if (recent.length >= MAX_MODEL_STARTS) return { status: "wait", retryAt: Math.min(...recent.map((charge) => charge.startedAt)) + MODEL_RATE_WINDOW_MS };
    if (all.filter((charge) => !charge.ended).length >= MAX_MODEL_UNSETTLED) return { status: "wait" };
    this.charges.set(context.callId, { caseRef: context.caseRef, binding, reserved: amount, actual: null, estimated: null, source: "reserved_upper_bound", ended: false, startedAt: now });
    return { status: "admitted" };
  }

  async settle(context: CallContext, amount: number | null, settlement?: BudgetSettlement): Promise<void> {
    const previous = this.charges.get(context.callId);
    if (!previous || previous.binding !== modelCallBinding(context)) throw new Error("invalid_request");
    Object.assign(previous, reconcileCharge(previous, amount, settlement));
    this.queue.changed();
  }

  cost(callId: string) {
    const charge = this.charges.get(callId);
    return charge ? { reserved: charge.reserved, actual: charge.actual, source: charge.source } : undefined;
  }

  async status(caseRef: string): Promise<BudgetStatus> {
    const all = [...this.charges.entries()];
    const own = all.filter(([, charge]) => charge.caseRef === caseRef);
    const cost = (values: typeof all) => values.reduce((total, [, charge]) => total + (charge.actual ?? charge.reserved), 0);
    return { reservedMicrousd: cost(own), pocMicrousd: cost(all), attempts: own.length, unsettledCalls: all.filter(([, charge]) => !charge.ended).length,
      startsLast60s: all.filter(([, charge]) => charge.startedAt > this.rateClock.now() - MODEL_RATE_WINDOW_MS).length,
      contractViolated: all.some(([, charge]) => charge.actual !== null && charge.actual > charge.reserved),
      charges: own.map(([callId, charge]) => ({ callId, reservedMicrousd: charge.reserved, actualMicrousd: charge.actual,
        estimatedMicrousd: charge.estimated, source: charge.source, execution: charge.ended ? "ended" : "unknown" })) };
  }
}
