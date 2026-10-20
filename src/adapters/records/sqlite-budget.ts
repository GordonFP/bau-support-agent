import type { CallContext, Ports } from "../../troubleshooting/application/ports.js";
import { CASE_MODEL_MICROUSD, MAX_MODEL_ATTEMPTS, MAX_MODEL_STARTS, MAX_MODEL_UNSETTLED, MODEL_RATE_WINDOW_MS, POC_MODEL_MICROUSD } from "../../troubleshooting/application/limits.js";
import { ModelBudgetQueue } from "../../troubleshooting/application/model-budget-queue.js";
import type { SqliteSession } from "./sqlite-session.js";
import type { BudgetSettlement, BudgetStatus } from "../../troubleshooting/application/model-budget.js";
import { modelCallBinding, reconcileCharge } from "../../troubleshooting/application/model-budget.js";

import { ModelRateClock } from "../../troubleshooting/application/model-rate-clock.js";

export class SqliteBudget {
  private readonly queue: ModelBudgetQueue;
  private readonly rateClock: ModelRateClock;

  constructor(private readonly session: SqliteSession, private readonly controls: Pick<Ports, "clock" | "sanitization">,
    private readonly beforeReserveCommit?: () => void) {
    this.rateClock = new ModelRateClock(controls.clock, Number(session.database.prepare("SELECT rate_ms FROM budget_clock WHERE id=1").get()!.rate_ms));
    this.queue = new ModelBudgetQueue(controls.clock, () => this.rateClock.now(), (context, amount) => this.admit(context, amount));
  }

  async reserve(context: CallContext, amount: number, beforeStart?: () => Promise<void>): Promise<boolean> {
    if (!this.controls.sanitization.safe({ callId: context.callId, caseRef: context.caseRef })) throw new Error("unsafe_content");
    return this.queue.reserve(context, amount, beforeStart);
  }

  private admit(context: CallContext, amount: number): boolean | number {
    return this.session.transaction(() => {
      const db = this.session.database;
      const binding = modelCallBinding(context);
      const existing = db.prepare("SELECT reserved,case_ref,binding FROM budget WHERE call_id=?").get(context.callId);
      if (existing) return String(existing.case_ref) === context.caseRef && Number(existing.reserved) === amount && existing.binding === binding;
      const totals = db.prepare(`SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) AS global_amount,
        COALESCE(SUM(CASE WHEN case_ref=? THEN COALESCE(actual,reserved) ELSE 0 END),0) AS case_amount,
        COUNT(CASE WHEN case_ref=? THEN 1 END) AS attempts, COUNT(CASE WHEN ended=0 THEN 1 END) AS unsettled,
        COUNT(CASE WHEN actual>reserved THEN 1 END) AS contradictions FROM budget`).get(context.caseRef, context.caseRef)!;
      if (Number(totals.global_amount) + amount > POC_MODEL_MICROUSD || Number(totals.case_amount) + amount > CASE_MODEL_MICROUSD ||
        Number(totals.attempts) >= MAX_MODEL_ATTEMPTS || Number(totals.contradictions) > 0) return false;
      const now = this.rateClock.now();
      db.prepare("UPDATE budget_clock SET rate_ms=? WHERE id=1").run(now);
      const rate = db.prepare("SELECT COUNT(*) AS starts, MIN(started_at) AS oldest FROM budget WHERE started_at>?").get(now - MODEL_RATE_WINDOW_MS)!;
      const next = Number(rate.starts) >= MAX_MODEL_STARTS ? Number(rate.oldest) + MODEL_RATE_WINDOW_MS : Infinity;
      if (Number(totals.unsettled) >= MAX_MODEL_UNSETTLED || Number.isFinite(next)) return next;
      db.prepare("INSERT INTO budget(call_id,case_ref,reserved,actual,source,ended,started_at,binding) VALUES(?,?,?,NULL,'reserved_upper_bound',0,?,?)").run(context.callId, context.caseRef, amount, now, binding);
      this.beforeReserveCommit?.();
      return true;
    });
  }

  async settle(context: CallContext, actual: number | null, settlement?: BudgetSettlement): Promise<void> {
    this.session.transaction(() => {
      const existing = this.session.database.prepare("SELECT actual,estimated,source,ended,binding FROM budget WHERE call_id=? AND case_ref=?").get(context.callId, context.caseRef);
      if (!existing || existing.binding !== modelCallBinding(context)) throw new Error("invalid_request");
      const next = reconcileCharge({ actual: existing.actual === null ? null : Number(existing.actual), estimated: existing.estimated === null ? null : Number(existing.estimated),
        source: String(existing.source), ended: Number(existing.ended) === 1 }, actual, settlement);
      this.session.database.prepare("UPDATE budget SET actual=?,estimated=?,source=?,ended=? WHERE call_id=?")
        .run(next.actual, next.estimated, next.source, next.ended ? 1 : 0, context.callId);
    });
    this.queue.changed();
  }

  async status(caseRef: string): Promise<BudgetStatus> {
    const row = this.session.database.prepare("SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) AS amount FROM budget WHERE case_ref=?").get(caseRef);
    const total = this.session.database.prepare(`SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) AS amount,
      COUNT(CASE WHEN ended=0 THEN 1 END) AS unsettled, COUNT(CASE WHEN started_at>? THEN 1 END) AS starts,
      COUNT(CASE WHEN actual>reserved THEN 1 END) AS contradictions FROM budget`).get(this.rateClock.now() - MODEL_RATE_WINDOW_MS)!;
    const charges = this.session.database.prepare("SELECT call_id,reserved,actual,estimated,source,ended FROM budget WHERE case_ref=? ORDER BY rowid").all(caseRef)
      .map((charge) => ({ callId: String(charge.call_id), reservedMicrousd: Number(charge.reserved), actualMicrousd: charge.actual === null ? null : Number(charge.actual),
        estimatedMicrousd: charge.estimated === null ? null : Number(charge.estimated), source: String(charge.source), execution: Number(charge.ended) === 1 ? "ended" as const : "unknown" as const }));
    return { reservedMicrousd: Number(row?.amount), pocMicrousd: Number(total.amount), attempts: charges.length,
      unsettledCalls: Number(total.unsettled), startsLast60s: Number(total.starts), contractViolated: Number(total.contradictions) > 0, charges };
  }

  close(): void { this.queue.close(); }
}
