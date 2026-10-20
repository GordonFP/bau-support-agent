import { createHash, randomUUID } from "node:crypto";
import type { Ports, TrustedActor } from "./ports.js";
import { isRetentionClosed, type DeletionCheck, type DeletionReceipt, type Retention, type RetentionStatus, type RetentionTrigger } from "./retention.js";
import { beforeDeadline } from "./deadline.js";
import { CLEANUP_MS, MAX_ACTIVE_CASES } from "./limits.js";

export interface RetentionState extends RetentionStatus {
  readonly events: readonly { readonly action: string; readonly at: string; readonly actorDigest: string; readonly result: string }[];
}
export interface RetentionStore {
  load(): RetentionState;
  save(state: RetentionState): void;
  purge?(): Promise<readonly DeletionCheck[]>;
}

const actorDigest = (actor: TrustedActor) => createHash("sha256").update(JSON.stringify([actor?.principalRef, actor?.tenantRef, actor?.destinationRef])).digest("hex");

export class RetentionLifecycle implements Retention {
  private controlsPending = 0;
  private purging: Promise<RetentionStatus> | undefined;
  private closing: Promise<void> | undefined;
  private readonly handlers = new Set<() => Promise<void>>();

  constructor(private readonly controls: Pick<Ports, "clock" | "authorization">, private readonly store: RetentionStore) {}

  private now(): number {
    const value = Date.parse(this.controls.clock.utc());
    if (!Number.isSafeInteger(value)) throw new Error("unavailable");
    return value;
  }

  private event(actor: TrustedActor, action: string, result: string): void {
    const current = this.store.load();
    this.store.save({ ...current, events: [...current.events, { action, result, at: this.controls.clock.utc(), actorDigest: actorDigest(actor) }] });
  }

  private async authorize(actor: TrustedActor, action: string): Promise<void> {
    if (this.controlsPending >= MAX_ACTIVE_CASES) throw new Error("unavailable");
    this.controlsPending++;
    const operation = Promise.resolve().then(() => this.controls.authorization.allows(`retention.${action}`, { ...actor, resourceRefs: [] })).finally(() => this.controlsPending--);
    const allowed = await beforeDeadline(this.controls.clock, this.controls.clock.now() + CLEANUP_MS, () => operation);
    if (!allowed) { this.event(actor, action, "denied"); throw new Error("denied"); }
  }

  private publicStatus(): RetentionStatus {
    const { events: _events, ...status } = this.store.load();
    return structuredClone(status);
  }

  private async fenced(operation: () => Promise<RetentionStatus>): Promise<RetentionStatus> {
    try { return await operation(); }
    catch (error) { throw new Error(error instanceof Error && ["denied", "invalid_request", "unavailable", "timeout"].includes(error.message) ? error.message : "unavailable"); }
  }

  recordTrigger(actor: TrustedActor, trigger: RetentionTrigger): Promise<RetentionStatus> {
    return this.fenced(() => this.register(actor, trigger));
  }

  private async register(actor: TrustedActor, trigger: RetentionTrigger): Promise<RetentionStatus> {
    actor = structuredClone(actor);
    trigger = structuredClone(trigger);
    await this.authorize(actor, "recordTrigger");
    const time = Date.parse(trigger?.decidedAt);
    if (!trigger || Object.keys(trigger).sort().join() !== "decidedAt,kind,scope,triggerRef" || trigger.scope !== "poc" ||
      !/^[a-zA-Z0-9:_-]{1,128}$/.test(trigger.triggerRef) || !["mvp_accepted", "poc_no_go", "terminated", "no_mvp"].includes(trigger.kind) ||
      !Number.isSafeInteger(time) || new Date(time).toISOString() !== trigger.decidedAt || time > this.now()) throw new Error("invalid_request");
    const current = this.store.load();
    const previous = current.triggers.find((item) => item.triggerRef === trigger.triggerRef);
    if (previous) {
      if (previous.kind !== trigger.kind || previous.decidedAt !== trigger.decidedAt || previous.scope !== trigger.scope) throw new Error("invalid_request");
      return this.publicStatus();
    }
    const dueAt = new Date(time + 30 * 24 * 60 * 60 * 1000).toISOString();
    const firstDue = current.dueAt && current.dueAt < dueAt ? current.dueAt : dueAt;
    this.store.save({ ...current, state: current.state === "untriggered" ? "scheduled" : current.state, dueAt: firstDue,
      triggers: [...current.triggers, { ...trigger, dueAt, registeredAt: this.controls.clock.utc() }],
      events: [...current.events, { action: "recordTrigger", result: "registered", at: this.controls.clock.utc(), actorDigest: actorDigest(actor) }] });
    return this.publicStatus();
  }

  purgeDue(actor: TrustedActor): Promise<RetentionStatus> { return this.fenced(() => this.purgeWhenDue(actor)); }

  private async purgeWhenDue(actor: TrustedActor): Promise<RetentionStatus> {
    actor = structuredClone(actor);
    await this.authorize(actor, "purgeDue");
    const status = this.publicStatus();
    if (!this.closed()) return status;
    if (status.state === "deleted") return status;
    if (this.purging) return this.purging;
    const work = this.purge(actor);
    this.purging = work;
    try { return await work; } finally { this.purging = undefined; }
  }

  private async purge(actor: TrustedActor): Promise<RetentionStatus> {
    const current = this.store.load();
    const startedAt = this.controls.clock.utc();
    this.store.save({ ...current, state: "deleting", events: [...current.events,
      { action: "purgeDue", at: startedAt, actorDigest: actorDigest(actor), result: "intent" }] });
    const checks: DeletionCheck[] = [];
    try {
      if (!this.closing) {
        const closing = Promise.allSettled([...this.handlers].map((handler) => Promise.resolve().then(handler))).then((results) => {
          if (results.some((result) => result.status === "rejected")) throw new Error("unavailable");
        });
        this.closing = closing;
        void closing.catch(() => { if (this.closing === closing) this.closing = undefined; });
      }
      await beforeDeadline(this.controls.clock, this.controls.clock.now() + CLEANUP_MS, () => this.closing!);
      checks.push({ scope: "runtime", result: "deleted", verification: "runtime contexts detached and local abort/close confirmed" });
      if (!this.store.purge) throw new Error("unavailable");
      checks.push(...await this.store.purge());
    } catch { checks.push({ scope: "incomplete_cleanup", result: "failed", verification: "cleanup did not complete; retry required" }); }
    const result = checks.every((check) => check.result === "deleted") ? "deleted" : "partial";
    const receipt: DeletionReceipt = { receiptRef: `deletion-${randomUUID()}`, scope: "poc", startedAt, completedAt: this.controls.clock.utc(), result, checks,
      retained: ["poc_costs", "unsettled_calls", "call_bindings", "event_digests", "delivery_keys", "lifecycle_receipts", "empty_lifetime_lock_files"],
      limits: ["Named controlled storage only; no device, unlinked storage, swap or forensic erasure proof.",
        "External Teams and provider copies are outside this service's deletion scope.", "Unverified backups and snapshots remain disabled."] };
    const latest = this.store.load();
    this.store.save({ ...latest, state: result, receipt, events: [...latest.events,
      { action: "purgeDue", at: this.controls.clock.utc(), actorDigest: actorDigest(actor), result }] });
    return this.publicStatus();
  }

  deletionStatus(actor: TrustedActor): Promise<RetentionStatus> { return this.fenced(() => this.status(actor)); }

  private async status(actor: TrustedActor): Promise<RetentionStatus> {
    actor = structuredClone(actor);
    await this.authorize(actor, "deletionStatus");
    this.event(actor, "deletionStatus", "allowed");
    return this.publicStatus();
  }

  closed(): boolean {
    const state = this.store.load();
    if (!isRetentionClosed(state, this.now())) return false;
    if (!state.closedAt) this.store.save({ ...state, closedAt: this.controls.clock.utc() });
    return true;
  }

  recordDeniedAccess(actor: TrustedActor, action: string): void { this.event(actor, action, "denied"); }

  onClose(handler: () => Promise<void>): void { this.handlers.add(handler); }
}
