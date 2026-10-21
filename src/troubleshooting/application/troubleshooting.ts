import { createHash, randomUUID } from "node:crypto";
import { TroubleshootingCase } from "../domain/simulator.js";
import { boundedBody, CASE_EXECUTION_MS, CASE_MODEL_MICROUSD, CLEANUP_MS, MAX_ACTIVE_CASES, MAX_LOG_RECORDS, MAX_MODEL_ATTEMPTS, TOOL_CALL_MS, phaseWindow } from "./limits.js";
import { beforeDeadline, schedule } from "./deadline.js";
import type { DiagnosticReport, SimulatorObservation } from "../domain/simulator.js";
import { SimulatorTarget, type LogRead } from "./simulator-target.js";
import { PspTarget } from "./psp-target.js";
import type { Acceptance, ApplicationCandidates, CallContext, CaseView, InformationQuestion, InformationReply, InformationResult, Ports, PspTargetCandidates, ReadResult, SafeReason, TrustedActor, VerifiedInbound } from "./ports.js";
import type { AuditDetails, CaseRecord, SavedContext, StoredCase } from "./records.js";
import { AuditBoundary } from "./audit-boundary.js";
import { deniedContext, recordDenial } from "./authorization-audit.js";
import { ModelExecution } from "./model-execution.js";
import { resolveDependencies, type OfflineScope, type ReadyScope } from "./dependencies.js";
import { sendNotice, sendReport } from "./communication.js";
import { codeQuery } from "./code-query.js";
import type { CodeSearchQuery, CodeSnippetQuery, CodeTraceQuery } from "./ports.js";
import { HostExecutions, type PhaseExecution } from "./phase-execution.js";
import { caseRepositories } from "./resource-scope.js";

const reasons = new Set<SafeReason>(["denied", "invalid_request", "contract_unverified", "schema_mismatch", "unavailable",
  "timeout", "cancelled", "rate_limited", "budget_exhausted", "version_unknown", "version_mismatch", "unsafe_content", "audit_unavailable"]);
const safeReason = (error: unknown): SafeReason => error instanceof Error && reasons.has(error.message as SafeReason)
  ? error.message as SafeReason : "unavailable";

interface RunningCase {
  readonly eventKey: string;
  readonly executions: Map<number, PhaseExecution>;
  terminalSaved?: boolean;
  inbound: VerifiedInbound;
  phaseId: number;
  readonly investigation: TroubleshootingCase;
  replyTail: Promise<void>;
  readonly replyFlights: Map<string, Promise<InformationResult>>;
  readonly replyEvents: Set<string>;
  readonly coverageWindows: Set<string>;
  readonly acceptedMono: number;
  finishedMono?: number;
  recordSequence: number;
  cleanupDeadline?: number;
  cancelDeadline?: () => void;
  target?: SimulatorTarget | PspTarget;
  view: CaseView;
}

export { type OfflineScope } from "./dependencies.js";

export class Troubleshooting {
  private readonly ready: ReadyTroubleshooting | undefined;
  private readonly unavailable: SafeReason;
  private readonly pspConfigured: boolean;
  constructor(configured: Partial<Ports>, scope?: OfflineScope) {
    const dependencies = resolveDependencies(configured, scope);
    this.pspConfigured = dependencies.status === "ready" ? !!dependencies.scope.psp : dependencies.pspConfigured;
    this.unavailable = dependencies.status === "unavailable" ? dependencies.reason : "unavailable";
    if (dependencies.status === "ready") this.ready = new ReadyTroubleshooting(dependencies.ports, dependencies.scope);
  }
  accept(inbound: VerifiedInbound): Promise<Acceptance> {
    if (this.ready) return this.ready.accept(inbound);
    if (!boundedBody(inbound?.input)) return Promise.resolve({ status: "denied", reason: "invalid_request" });
    try { structuredClone(inbound); } catch { return Promise.resolve({ status: "denied", reason: "invalid_request" }); }
    return Promise.resolve({ status: "service_unavailable", reason: inbound?.input?.scenario === "psp" && !this.pspConfigured ? "contract_unverified" : this.unavailable });
  }
  provideInformation(reply: InformationReply, signal?: AbortSignal): Promise<InformationResult> {
    if (this.ready) return this.ready.provideInformation(reply, signal);
    if (!boundedBody({ reply: reply?.reply, content: reply?.content })) return Promise.resolve({ status: "denied", reason: "invalid_request" });
    try { structuredClone(reply); } catch { return Promise.resolve({ status: "denied", reason: "invalid_request" }); }
    return Promise.resolve({ status: "denied", reason: "denied" });
  }
  cancel(actor: TrustedActor, caseRef: string, signal?: AbortSignal): Promise<CaseView | { readonly status: "denied" }> {
    return this.ready?.cancel(actor, caseRef, signal) ?? Promise.resolve({ status: "denied" });
  }
  get(actor: TrustedActor, caseRef: string, beforeDisclose?: (current: () => void, owner: SavedContext) => Promise<void>, signal?: AbortSignal): Promise<CaseView | { readonly status: "denied" }> {
    return this.ready?.get(actor, caseRef, beforeDisclose, signal) ?? Promise.resolve({ status: "denied" });
  }
  close(): Promise<void> { return this.ready?.close() ?? Promise.resolve(); }
}

class ReadyTroubleshooting {
  private readonly cases = new Map<string, RunningCase>();
  private readonly acceptances = new Map<string, Promise<Acceptance>>();
  private readonly pendingAdmissions = new Set<string>();
  private readonly persistedLookups = new Map<string, Promise<Acceptance | null>>();
  private sequence = 0;
  private readonly hostExecutions = new HostExecutions();
  private readonly terminalReads = new Map<string, { deadline: number; work: Promise<{ saved: StoredCase; owner: SavedContext; current: () => void } | null> }>();
  private readonly disclosureWork = new Set<Promise<void>>();
  private hostClosed = false;
  private closing?: Promise<void>;
  private readonly auditBoundary?: AuditBoundary;
  constructor(private configured: Ports, private readonly scope: ReadyScope) {
    this.auditBoundary = new AuditBoundary(configured.audit, (context, action, stage) => this.auditFailure(context, action, stage));
    this.configured = { ...configured, audit: this.auditBoundary.port };
    this.configured.retention?.onClose(() => this.close());
  }

  // Host lifecycle only; never exposed as a Teams command or Agent tool, and never deletes durable data.
  close(): Promise<void> {
    this.hostClosed = true;
    return this.closing ??= (async () => {
      const ports = this.configured;
      const active = [...this.cases.values()];
      let cleanupFailed = false;
      for (const running of active) {
        running.view = { ...running.view, state: "stopped", stopReason: "cancelled" };
        running.investigation.stop(); running.investigation.forget(); this.execution(running).controller.abort(); running.cancelDeadline?.();
        try { ports.sanitization.clear(this.execution(running).context.caseRef); } catch { cleanupFailed = true; }
        running.inbound = { ...running.inbound, input: { question: "" } };
        delete running.target;
      }
      this.cases.clear(); this.acceptances.clear(); this.pendingAdmissions.clear(); this.persistedLookups.clear();
      const closed = await Promise.allSettled([this.hostExecutions.close(), ...active.flatMap((running) => [
        this.execution(running).abort(), ...[...running.executions.values()].map((phase) => phase.close()), ...running.replyFlights.values()])]);
      if (cleanupFailed || closed.some((result) => result.status === "rejected")) throw new Error("unavailable");
    })();
  }

  private trackControl<T>(task: Promise<T>): Promise<T> { return this.hostExecutions.track(task); }

  private execution(running: RunningCase, phaseId = running.phaseId): PhaseExecution {
    const phase = running.executions.get(phaseId);
    if (!phase) throw new Error("unavailable");
    return phase;
  }

  private retentionClosed(): boolean {
    try { return this.hostClosed || this.configured.retention?.closed() === true; } catch { return true; }
  }

  async accept(inbound: VerifiedInbound): Promise<Acceptance> {
    if (this.retentionClosed()) return { status: "service_unavailable", reason: "unavailable" };
    if (!boundedBody(inbound?.input)) return { status: "denied", reason: "invalid_request" };
    try { inbound = structuredClone(inbound); } catch { return { status: "denied", reason: "invalid_request" }; }
    const key = createHash("sha256").update(JSON.stringify([inbound?.tenantRef, inbound?.destinationRef, inbound?.eventRef])).digest("hex");
    const previous = this.acceptances.get(key);
    if (previous) {
      const accepted = await previous;
      if (!("view" in accepted)) return accepted;
      const running = this.cases.get(accepted.view.caseRef);
      if (!running) {
        return await this.persistedDuplicate(inbound, key, accepted.view.caseRef) ?? { status: "denied", reason: "denied" };
      }
      if (this.execution(running).context.principalRef !== inbound.principalRef) {
        await this.denied(inbound, accepted.view.caseRef);
        return { status: "denied", reason: "denied" };
      }
      try {
        if (!await this.configured.authorization.allows("accept", this.execution(running).context)) {
          await recordDenial(this.configured.audit, this.execution(running).context);
          return { status: "denied", reason: "denied" };
        }
        return { status: "duplicate", view: this.viewOf(running, this.configured) };
      } catch { return { status: "service_unavailable", reason: "unavailable" }; }
    }
    let admissionPhase: ReturnType<typeof phaseWindow> | undefined;
    if (this.configured.admission?.lookup) {
      try { if (this.configured.clock) admissionPhase = phaseWindow(this.configured.clock); }
      catch { return { status: "service_unavailable", reason: "unavailable" }; }
      const duplicate = await this.persistedDuplicate(inbound, key, undefined, admissionPhase?.deadline);
      if (duplicate) return duplicate;
      if (this.acceptances.has(key)) return this.accept(inbound);
    }
    const active = [...this.cases.values()].filter((item) => item.view.state === "investigating" || item.view.state === "awaiting_input").length;
    if (active + this.pendingAdmissions.size >= MAX_ACTIVE_CASES) return { status: "service_unavailable", reason: "unavailable" };
    this.pendingAdmissions.add(key);
    let timedOut = false;
    const operation = this.acceptVerified(inbound, key, admissionPhase);
    this.acceptances.set(key, operation);
    try {
      const result = await operation;
      timedOut = !("view" in result) && result.reason === "timeout";
      if (!("view" in result) && !timedOut) this.acceptances.delete(key);
      return result;
    } catch {
      this.acceptances.delete(key);
      return { status: "service_unavailable", reason: "unavailable" };
    } finally { if (!timedOut) this.pendingAdmissions.delete(key); }
  }

  private async persistedDuplicate(inbound: VerifiedInbound, key: string, caseRef?: string, originalDeadline?: number): Promise<Acceptance | null> {
    const flightKey = JSON.stringify([key, inbound.principalRef]);
    const previous = this.persistedLookups.get(flightKey);
    if (previous) return previous;
    const ports = this.configured;
    if (!ports.clock || !ports.records || this.persistedLookups.size + this.pendingAdmissions.size >= MAX_ACTIVE_CASES) {
      return { status: "service_unavailable", reason: "unavailable" };
    }
    const deadline = originalDeadline ?? ports.clock.now() + CASE_EXECUTION_MS;
    let expired = false;
    const work = this.trackControl((async (): Promise<Acceptance | null> => {
      const found = caseRef ? { caseRef } : await ports.admission.lookup!(key);
      if (this.retentionClosed() || expired || ports.clock.now() >= deadline) throw new Error("timeout");
      if (!found) return null;
      let authority: SavedContext | undefined;
      const saved = await ports.records.read(inbound, found.caseRef, async (_current, owner) => {
        authority = owner;
        if (inbound.principalRef !== owner.principalRef || inbound.tenantRef !== owner.tenantRef || inbound.destinationRef !== owner.destinationRef ||
          !await ports.authorization.allows("accept", owner)) throw new Error("denied");
      });
      return !this.retentionClosed() && authority && (!ports.authorization.current || ports.authorization.current("accept", authority) === true) && saved?.scope === "full" ? { status: "duplicate", view: saved.view } : { status: "denied", reason: "denied" };
    })());
    const operation = beforeDeadline(ports.clock, deadline, () => work, undefined, () => { expired = true; })
      .catch((): Acceptance => ({ status: "service_unavailable", reason: expired ? "timeout" : "unavailable" }));
    this.persistedLookups.set(flightKey, operation);
    void work.finally(() => this.persistedLookups.delete(flightKey)).catch(() => {});
    return operation;
  }

  private async acceptVerified(inbound: VerifiedInbound, key: string, admissionPhase?: ReturnType<typeof phaseWindow>): Promise<Acceptance> {
    if (inbound.input?.scenario === "psp" && !this.scope.psp) return { status: "service_unavailable", reason: "contract_unverified" };
    const ports = this.configured;
    if (!inbound || inbound.conversationKind !== "private" || !inbound.eventRef || !inbound.tenantRef ||
        !inbound.principalRef || !inbound.destinationRef ||
        ![inbound.input?.applicationId, inbound.input?.customerId].some((id) => typeof id === "string" && id.length > 0) ||
        (inbound.input.applicationId !== undefined && inbound.input.customerId !== undefined) ||
        (inbound.input.scenario !== undefined && !["simulator", "psp"].includes(inbound.input.scenario)) ||
        (inbound.input.scenario !== "psp" && (inbound.input.shopId !== undefined || inbound.input.bindingId !== undefined)) ||
        [inbound.input.shopId, inbound.input.bindingId].some((id) => id !== undefined && (typeof id !== "string" || !id || Buffer.byteLength(id) > 1024)) ||
        typeof inbound.input.question !== "string" || !Number.isFinite(Date.parse(inbound.receivedAt))) {
      return { status: "denied", reason: "invalid_request" };
    }
    if (inbound.input.scenario !== "psp" && !this.scope.resourceRefs.includes("simulator-source")) return { status: "service_unavailable", reason: "contract_unverified" };
    const caseRef = ports.admission.allocateCaseRef?.() ?? `case-${++this.sequence}`;
    const controller = new AbortController();
    const phase = admissionPhase ?? phaseWindow(ports.clock);
    const now = phase.startedAt;
    const context: CallContext = Object.freeze({ caseRef, phaseId: 1, callId: `${caseRef}:accept`, principalRef: inbound.principalRef,
      tenantRef: inbound.tenantRef, destinationRef: inbound.destinationRef, policyVersion: "mock-policy-1", approvalRef: "mock-approval-1",
      resourceRefs: this.scope.resourceRefs, snapshotRef: this.scope.snapshotRef, budgetRef: caseRef,
      deadline: phase.deadline, signal: controller.signal });
    const execution = this.hostExecutions.create(context, controller, ports.agent, () => {
      const running = this.cases.get(caseRef); if (running) this.releaseCase(running);
    });
    const work = this.trackControl(execution.produce(() => this.confirmAcceptance(inbound, key, ports, context, controller, phase, execution)));
    void work.finally(() => {
      const running = this.cases.get(caseRef);
      if (!running || ["completed", "stopped"].includes(running.view.state)) void execution.close().catch(() => {});
    }).catch(() => {});
    void work.finally(() => { this.pendingAdmissions.delete(key); const running = [...this.cases.values()].find((item) => item.eventKey === key); if (running) this.releaseCase(running); }).catch(() => {});
    try {
      return await beforeDeadline(ports.clock, context.deadline, () => work, undefined, () => controller.abort());
    } catch {
      const candidate = this.cases.get(caseRef);
      if (candidate) {
        if (candidate.view.state === "investigating") {
          candidate.view = { ...candidate.view, state: "stopped", stopReason: "timeout" };
          this.endPhase(candidate, "stopped", ports);
        }
        this.acceptances.set(key, Promise.resolve({ status: "duplicate", view: this.viewOf(candidate, ports) }));
      } else {
        try { ports.sanitization.clear(caseRef); } catch { /* expired candidate stays closed */ }
      }
      return { status: "service_unavailable", reason: "timeout" };
    }
  }

  private async confirmAcceptance(inbound: VerifiedInbound, key: string, ports: Ports, context: CallContext,
    controller: AbortController, phase: ReturnType<typeof phaseWindow>, execution: PhaseExecution): Promise<Acceptance> {
    const caseRef = context.caseRef;
    const now = phase.startedAt;
    const check = () => { if (this.retentionClosed() || controller.signal.aborted || ports.clock.now() >= context.deadline) throw new Error("timeout"); };
    let safeInput: VerifiedInbound["input"];
    try {
      const allowed = await ports.authorization.allows("accept", context);
      check();
      if (!allowed) { await recordDenial(ports.audit, context); return { status: "denied", reason: "denied" }; }
      safeInput = ports.sanitization.sanitize(inbound.input, caseRef);
      if (!ports.sanitization.safe(safeInput)) {
        ports.sanitization.clear(caseRef);
        return { status: "denied", reason: "unsafe_content" };
      }
      await ports.audit.intent(context, "accept");
      check();
    } catch (error) {
      try { ports.sanitization.clear(caseRef); } catch { /* rejected candidate stays closed */ }
      return { status: "service_unavailable", reason: safeReason(error) === "timeout" ? "timeout" : "audit_unavailable" };
    }
    const view: CaseView = { caseRef, phaseId: 1, state: "investigating", receivedAt: inbound.receivedAt,
      acceptedAt: now, phaseStartedAt: now, deadlineAt: phase.deadlineAt, deliveryStatus: "pending",
      usage: { modelAttempts: 0, logRecords: 0, logCoverageMs: 0 }, elapsedMs: 0,
      phases: [{ phaseId: 1, startedAt: now }], inputWaits: [] };
    const investigation = new TroubleshootingCase(caseRef);
    const running: RunningCase = { eventKey: key, executions: new Map([[context.phaseId, execution]]), inbound: structuredClone(inbound), phaseId: context.phaseId, view, investigation,
      replyTail: Promise.resolve(), replyFlights: new Map(), replyEvents: new Set(), coverageWindows: new Set(),
      target: inbound.input.scenario === "psp" ? new PspTarget(inbound.input, safeInput) : new SimulatorTarget(inbound.input, safeInput),
      recordSequence: 0, acceptedMono: context.deadline - CASE_EXECUTION_MS };
    let admitted = false;
    try {
      const confirmation = await ports.admission.confirm({ key, caseRef, principalRef: context.principalRef,
        initial: { context, view, input: safeInput } });
      if (confirmation.status === "full") return { status: "service_unavailable", reason: "unavailable" };
      if (confirmation.status === "duplicate") {
        const existing = this.cases.get(confirmation.caseRef);
        if (!existing && confirmation.principalRef === context.principalRef) {
          const saved = await ports.records.read(inbound, confirmation.caseRef);
          if (saved?.scope === "full") return { status: "duplicate", view: saved.view };
        }
        return existing && confirmation.principalRef === context.principalRef && this.owns(inbound, existing) &&
          await ports.authorization.allows("accept", this.execution(existing).context)
          ? { status: "duplicate", view: this.viewOf(existing, ports) } : { status: "service_unavailable", reason: "unavailable" };
      }
      admitted = true;
      execution.activate();
    } catch { return { status: "service_unavailable", reason: "unavailable" }; }
    finally { if (!admitted) { try { ports.sanitization.clear(caseRef); } catch { /* candidate was not accepted */ } } }
    {
      if (this.retentionClosed()) {
        controller.abort(); investigation.stop(); investigation.forget();
        running.view = { ...running.view, state: "stopped", stopReason: "cancelled", phases: running.view.phases.map((value) => ({ ...value, endedAt: ports.clock.utc(), outcome: "stopped" })) };
        try { ports.sanitization.clear(caseRef); } catch { /* the closed candidate remains inaccessible */ }
        try { await ports.records.append(context, { recordRef: `${caseRef}:view:closed-admission`, schemaVersion: 1, kind: "view", payload: running.view }); } catch { /* expired storage may already be closed; restart still cannot restore work */ }
        await ports.admission.release(caseRef);
        return { status: "service_unavailable", reason: "cancelled" };
      }
      this.cases.set(caseRef, running);
      if (controller.signal.aborted || ports.clock.now() >= context.deadline) {
        running.view = { ...running.view, state: "stopped", stopReason: "timeout" };
        this.endPhase(running, "stopped", ports);
        this.acceptances.set(key, Promise.resolve({ status: "duplicate", view: this.viewOf(running, ports) }));
        return { status: "service_unavailable", reason: "timeout" };
      }
      try { await ports.audit.complete(context, "accept", "accepted"); }
      catch {
        if (running.view.state === "stopped") return { status: "service_unavailable", reason: running.view.stopReason ?? "unavailable" };
        running.view = { ...running.view, state: "stopped", stopReason: "audit_unavailable" };
        this.endPhase(running, "stopped", ports);
        return { status: "service_unavailable", reason: "audit_unavailable" };
      }
      if (running.view.state === "stopped") return { status: "service_unavailable", reason: running.view.stopReason ?? "unavailable" };
      if (controller.signal.aborted || ports.clock.now() >= context.deadline) {
        running.view = { ...running.view, state: "stopped", stopReason: "timeout" };
        this.endPhase(running, "stopped", ports);
        return { status: "service_unavailable", reason: "timeout" };
      }
      this.armDeadline(running, ports);
      // The inbound caller receives acceptance independently of investigation completion.
      void this.investigate(running, ports);
      return { status: "accepted", view: structuredClone(view) };
    }
  }

  async provideInformation(reply: InformationReply, signal?: AbortSignal): Promise<InformationResult> {
    if (this.retentionClosed()) return { status: "denied", reason: "denied" };
    if (!boundedBody({ reply: reply?.reply, content: reply?.content })) return { status: "denied", reason: "invalid_request" };
    try { reply = structuredClone(reply); } catch { return { status: "denied", reason: "invalid_request" }; }
    const running = this.cases.get(reply?.reply?.caseRef);
    if (!running) {
      const saved = await this.terminalView(reply, reply?.reply?.caseRef, "provideInformation", reply?.eventRef, signal);
      return saved ? saved.duplicate ? { status: "duplicate", view: saved.view } : { status: "terminal", view: saved.view, newCaseRequired: true } : { status: "denied", reason: "denied" };
    }
    if (!running || reply.principalRef !== this.execution(running).context.principalRef || reply.tenantRef !== this.execution(running).context.tenantRef ||
      reply.destinationRef !== this.execution(running).context.destinationRef) {
      await this.denied(reply, reply?.reply?.caseRef ?? "unresolved");
      return { status: "denied", reason: "denied" };
    }
    const previous = running.replyFlights.get(reply.eventRef);
    if (previous) {
      await previous;
      try {
        if (!await this.configured.authorization.allows("provideInformation", this.execution(running).context)) return { status: "denied", reason: "denied" };
        return { status: "duplicate", view: this.viewOf(running, this.configured) };
      } catch { return { status: "denied", reason: "unavailable" }; }
    }
    if (running.replyFlights.size >= MAX_ACTIVE_CASES) return { status: "denied", reason: "rate_limited" };
    const operation = running.replyTail.then(() => this.resumeFromInformation(running, reply, this.configured));
    running.replyFlights.set(reply.eventRef, operation);
    running.replyTail = operation.then(() => {}, () => {});
    try { return await operation; } finally { running.replyFlights.delete(reply.eventRef); this.releaseCase(running); }
  }

  private async resumeFromInformation(running: RunningCase, reply: InformationReply, ports: Ports): Promise<InformationResult> {
    try {
      if (!await ports.authorization.allows("provideInformation", this.execution(running).context)) { await recordDenial(ports.audit, this.execution(running).context); return { status: "denied", reason: "denied" }; }
      if (running.replyEvents.has(reply.eventRef)) return { status: "duplicate", view: this.viewOf(running, ports) };
      if (running.view.state === "completed" || running.view.state === "stopped") return { status: "terminal", view: this.viewOf(running, ports), newCaseRequired: true };
      if (reply.content && ["applicationId", "customerId", "shopId", "bindingId", "scenario"].some((field) => field in reply.content)) {
        return { status: "denied", reason: "invalid_request", newCaseRequired: true };
      }
      if (running.view.state !== "awaiting_input" || running.view.question?.questionId !== reply.reply.questionId ||
        !reply.eventRef || !Number.isFinite(Date.parse(reply.receivedAt))) return { status: "denied", reason: "invalid_request" };
      const target = running.target;
      if (!target || !target.select(reply.content)) {
        running.replyEvents.add(reply.eventRef);
        return { status: "needs_information", view: this.viewOf(running, ports) };
      }
      const context = { ...this.execution(running).context, callId: `${this.execution(running).context.caseRef}:reply:${reply.eventRef}` };
      const budget = await ports.budget.status(context.caseRef);
      if (running.view.state !== "awaiting_input") return { status: "terminal", view: this.viewOf(running, ports), newCaseRequired: true };
      if (running.view.usage.modelAttempts >= MAX_MODEL_ATTEMPTS || running.view.usage.logRecords >= MAX_LOG_RECORDS || budget.reservedMicrousd >= CASE_MODEL_MICROUSD) {
        running.view = { ...running.view, state: "stopped", stopReason: "budget_exhausted",
          inputWaits: running.view.inputWaits.map((wait) => wait.questionId === reply.reply.questionId
            ? { ...wait, endedAt: ports.clock.utc(), replyEventRef: reply.eventRef, replyReceivedAt: reply.receivedAt } : wait) };
        this.endPhase(running, "stopped", ports);
        return { status: "terminal", view: this.viewOf(running, ports), newCaseRequired: true };
      }
      await ports.audit.intent(context, "provideInformation");
      await ports.audit.complete(context, "provideInformation", "resumed");
      if (running.view.state !== "awaiting_input") return { status: "terminal", view: this.viewOf(running, ports), newCaseRequired: true };
      if (target.applicationRef) running.investigation.selectTarget(target.applicationRef);
      const phaseId = running.investigation.resume();
      const controller = new AbortController();
      const phase = phaseWindow(ports.clock);
      const startedAt = phase.startedAt;
      const resumedContext = Object.freeze({ ...this.execution(running).context, phaseId, callId: `${context.caseRef}:phase-${phaseId}:start`,
        deadline: phase.deadline, signal: controller.signal });
      running.executions.set(phaseId, this.hostExecutions.create(resumedContext, controller, ports.agent, () => this.releaseCase(running)));
      running.phaseId = phaseId;
      this.execution(running).activate();
      const { question: _question, waitingStartedAt: _waiting, ...view } = running.view;
      running.view = { ...view, phaseId, state: "investigating", phaseStartedAt: startedAt,
        deadlineAt: phase.deadlineAt,
        phases: [...view.phases, { phaseId, startedAt }],
        inputWaits: view.inputWaits.map((wait) => wait.questionId === reply.reply.questionId
          ? { ...wait, endedAt: startedAt, replyEventRef: reply.eventRef, replyReceivedAt: reply.receivedAt } : wait) };
      running.replyEvents.add(reply.eventRef);
      this.armDeadline(running, ports);
      const saving = this.trackWork(running, phaseId, () => this.saveView(running, ports));
      await beforeDeadline(ports.clock, phase.deadline, () => saving, controller.signal);
      if (this.retentionClosed() || running.view.state !== "investigating") return { status: "denied", reason: "cancelled" };
      void this.investigate(running, ports);
      return { status: "resumed", view: this.viewOf(running, ports) };
    } catch { return { status: "denied", reason: "unavailable" }; }
  }

  private viewOf(running: RunningCase, ports: Ports): CaseView {
    if (this.retentionClosed()) throw new Error("denied");
    const initialDelay = Math.max(0, Date.parse(running.view.acceptedAt) - Date.parse(running.view.receivedAt));
    return structuredClone({ ...running.view, elapsedMs: initialDelay + (running.finishedMono ?? ports.clock.now()) - running.acceptedMono });
  }

  private async saveRecord(running: RunningCase, context: CallContext, ports: Ports, record: CaseRecord): Promise<void> {
    try { await ports.records.append(context, record); }
    catch { this.auditBoundary?.fail(context, "records.append", "complete"); throw new Error("audit_unavailable"); }
  }

  private trackWork<T>(running: RunningCase, phaseId: number, task: () => Promise<T>): Promise<T> {
    return this.execution(running, phaseId).run(task);
  }

  private saveView(running: RunningCase, ports: Ports): Promise<void> {
    return this.saveRecord(running, this.execution(running).context, ports, { recordRef: `${this.execution(running).context.caseRef}:view:${++running.recordSequence}`,
      schemaVersion: 1, kind: "view", payload: this.viewOf(running, ports) });
  }

  private auditFailure(context: CallContext, action: string, stage: "intent" | "complete"): void {
    const running = this.cases.get(context.caseRef);
    if (!running || this.retentionClosed()) return;
    const ports = this.configured;
    if (running.view.state === "investigating" || running.view.state === "awaiting_input") {
      running.view = { ...running.view, state: "stopped", stopReason: "audit_unavailable" };
      this.endPhase(running, "stopped", ports);
    }
    void this.stopPhase(running, this.execution(running).context, "audit_unavailable", ports);
    if (stage !== "complete" && action !== "delivery.send") return;
    const current = this.execution(running).context;
    const deadline = running.cleanupDeadline ?? ports.clock.now() + CLEANUP_MS;
    const notice = "Investigation stopped because audit storage is unavailable." as const;
    const allowed = async () => {
      if (!await ports.authorization.allows("delivery.fault", current) || this.retentionClosed() || ports.clock.now() >= deadline) throw new Error("denied");
    };
    const task = this.trackWork(running, current.phaseId, async () => {
      await allowed();
      await ports.delivery.fault(current.destinationRef, notice, `${current.caseRef}:audit-fault`, {
        caseRef: current.caseRef, phaseId: current.phaseId, segment: 1, total: 1, text: notice, deadline,
        signal: new AbortController().signal, current: () => { if (this.retentionClosed() || ports.clock.now() >= deadline || ports.authorization.current?.("delivery.fault", current) !== true) throw new Error("denied"); }, beforeWrite: async (text = notice) => { if (text !== notice) throw new Error("denied"); await allowed(); },
      });
    });
    void beforeDeadline(ports.clock, deadline, () => task).catch(() => {});
  }

  private endPhase(running: RunningCase, outcome: "awaiting_input" | "completed" | "stopped", ports: Ports): void {
    running.view = { ...running.view, phases: running.view.phases.map((phase) => phase.phaseId === this.execution(running).context.phaseId && !phase.endedAt
      ? { ...phase, endedAt: ports.clock.utc(), outcome } : phase) };
    if (outcome !== "awaiting_input") {
      running.investigation.stop();
      running.finishedMono ??= ports.clock.now();
      running.cleanupDeadline ??= ports.clock.now() + CLEANUP_MS;
      running.cancelDeadline?.();
      this.execution(running).controller.abort();
      try { ports.sanitization.clear(this.execution(running).context.caseRef); } catch { /* no raw cleanup errors leave the host */ }
      running.inbound = { ...running.inbound, input: { question: "" } };
      delete running.target;
      void this.trackWork(running, this.execution(running).context.phaseId, () => Promise.resolve().then(() => ports.admission.release(this.execution(running).context.caseRef))).catch(() => {});
    }
    const context = this.execution(running).context;
    const record: CaseRecord = { recordRef: `${context.caseRef}:view:${++running.recordSequence}`,
      schemaVersion: 1, kind: "view", payload: this.viewOf(running, ports) };
    void this.trackWork(running, context.phaseId, () => Promise.resolve().then(() => ports.records.append(context, record)).then(() => { if (outcome !== "awaiting_input") running.terminalSaved = true; }))
      .catch(() => this.auditBoundary?.fail(context, "records.append", "complete"));
  }

  private armDeadline(running: RunningCase, ports: Ports): void {
    running.cancelDeadline?.();
    const context = this.execution(running).context;
    const controller = this.execution(running).controller;
    const expire = () => {
      if (this.execution(running).context.phaseId !== context.phaseId || running.view.state !== "investigating" ||
        controller.signal.aborted || ports.clock.now() < context.deadline) return;
      running.view = { ...running.view, state: "stopped", stopReason: "timeout" };
      this.endPhase(running, "stopped", ports);
      void this.stopPhase(running, context, "timeout", ports);
    };
    running.cancelDeadline = schedule(ports.clock, context.deadline, expire);
  }

  private stopPhase(running: RunningCase, context: CallContext, reason: string, ports: Ports): Promise<void> {
    const deadline = running.cleanupDeadline ?? ports.clock.now() + CLEANUP_MS;
    return this.execution(running, context.phaseId).stop(() => beforeDeadline(ports.clock, deadline, async () => {
      if (this.auditBoundary?.hasLost(context.caseRef)) {
        const abort = this.execution(running, context.phaseId).abort();
        void this.execution(running, context.phaseId).close().catch(() => {});
        await abort;
        return;
      }
      const audit = { ...context, callId: `${context.caseRef}:phase-${context.phaseId}:${reason}` };
      try { await this.trackWork(running, context.phaseId, () => Promise.resolve().then(() => ports.audit.intent(audit, reason))); } catch { /* local stop remains effective */ }
      if (ports.clock.now() >= deadline) return;
      const abort = this.execution(running, context.phaseId).abort();
      const complete = this.trackWork(running, context.phaseId, () => Promise.resolve().then(() => ports.audit.complete(audit, reason, "stopped")));
      void this.execution(running, context.phaseId).close().catch(() => {});
      await Promise.allSettled([abort, complete]);
    }).catch(() => {}));
  }

  private releaseCase(running: RunningCase): void {
    if (!["completed", "stopped"].includes(running.view.state) || running.replyFlights.size ||
      this.pendingAdmissions.has(running.eventKey) || !running.terminalSaved || [...running.executions.values()].some((phase) => !phase.closed)) return;
    running.investigation.forget();
    if (this.cases.get(this.execution(running).context.caseRef) === running) this.cases.delete(this.execution(running).context.caseRef);
    this.acceptances.delete(running.eventKey);
    running.replyEvents.clear(); running.coverageWindows.clear();
  }

  // Host cancellation ends only this caller's wait; the shared record operation retains its bounded slot until it settles.
  private async restoredView(actor: TrustedActor, caseRef: string, action: "cancel" | "provideInformation" | "get",
    signal?: AbortSignal, beforeDisclose?: (current: () => void, owner: SavedContext) => Promise<void>): Promise<StoredCase | null> {
    const ports = this.configured;
    if (this.retentionClosed() || signal?.aborted || !actor || typeof caseRef !== "string" || !caseRef) return null;
    const key = JSON.stringify([actor.principalRef, actor.tenantRef, actor.destinationRef, caseRef, action]);
    let flight = this.terminalReads.get(key);
    if (!flight) {
      if (this.terminalReads.size >= MAX_ACTIVE_CASES) return null;
      const deadline = ports.clock.now() + CLEANUP_MS;
      const check = () => { if (this.retentionClosed() || ports.clock.now() >= deadline) throw new Error("denied"); };
      const work = this.trackControl((async () => {
        let owner: SavedContext | undefined;
        let resourceCurrent: (() => void) | undefined;
        const saved = await ports.records.read(actor, caseRef, async (current, authority) => {
          check(); owner = authority; resourceCurrent = current;
          if (actor.principalRef !== owner.principalRef || actor.tenantRef !== owner.tenantRef || actor.destinationRef !== owner.destinationRef ||
            !await ports.authorization.allows(action, owner)) throw new Error("denied");
          check();
          if (action === "get") {
            const context = { ...owner, callId: `${caseRef}:get:${randomUUID()}`, deadline, signal: new AbortController().signal };
            await ports.audit.intent(context, "get"); check(); await ports.audit.complete(context, "get", "allowed"); check();
          }
        });
        check();
        if (!owner || !resourceCurrent || saved?.scope !== "full") return null;
        const authority = owner, resource = resourceCurrent;
        const current = () => { check(); resource(); if (ports.authorization.current && ports.authorization.current(action, authority) !== true) throw new Error("denied"); };
        current();
        return { saved, owner: authority, current };
      })().catch(() => null));
      flight = { deadline, work };
      this.terminalReads.set(key, flight);
      void work.finally(() => { if (this.terminalReads.get(key)?.work === work) this.terminalReads.delete(key); }).catch(() => {});
    }
    try {
      return await beforeDeadline(ports.clock, flight.deadline, async () => {
        const result = await flight.work;
        if (!result) return null;
        const current = () => { if (signal?.aborted) throw new Error("denied"); result.current(); };
        current();
        if (beforeDisclose) {
          if (this.disclosureWork.size >= MAX_ACTIVE_CASES) return null;
          const disclosure = this.trackControl(Promise.resolve().then(async () => {
            try { current(); await beforeDisclose(current, result.owner); current(); }
            catch { await recordDenial(ports.audit, deniedContext(actor, caseRef, ports)); throw new Error("denied"); }
          }));
          this.disclosureWork.add(disclosure);
          const ended = () => { this.disclosureWork.delete(disclosure); };
          void disclosure.then(ended, ended);
          await disclosure;
        }
        current();
        return { ...result.saved, view: structuredClone(result.saved.view) };
      }, signal);
    } catch { return null; }
  }

  private async terminalView(actor: TrustedActor, caseRef: string, action: "cancel" | "provideInformation", eventRef?: string, signal?: AbortSignal): Promise<{ view: CaseView; duplicate: boolean } | null> {
    const saved = await this.restoredView(actor, caseRef, action, signal);
    if (!saved || !["completed", "stopped"].includes(saved.view.state)) return null;
    return { view: saved.view, duplicate: !!eventRef && saved.audits.some((item) => item.action === "provideInformation" && item.stage === "complete" && item.outcome === "resumed" && item.callId === `${caseRef}:reply:${eventRef}`) };
  }

  private owns(actor: TrustedActor, running: RunningCase): boolean {
    return !!actor && actor.principalRef === this.execution(running).context.principalRef && actor.tenantRef === this.execution(running).context.tenantRef && actor.destinationRef === this.execution(running).context.destinationRef;
  }

  private async denied(actor: TrustedActor, caseRef: string): Promise<void> {
    const ports = this.configured;
    try { await recordDenial(ports.audit, deniedContext(actor, caseRef, ports)); } catch { /* no disclosure follows denial */ }
  }

  async cancel(actor: TrustedActor, caseRef: string, signal?: AbortSignal): Promise<CaseView | { readonly status: "denied" }> {
    if (this.retentionClosed()) return { status: "denied" };
    const running = this.cases.get(caseRef);
    const ports = this.configured;
    if (!running) { const view = await this.terminalView(actor, caseRef, "cancel", undefined, signal); return view?.view ?? { status: "denied" }; }
    if (!this.owns(actor, running)) { await this.denied(actor, caseRef); return { status: "denied" }; }
    try {
      if (!await ports.authorization.allows("cancel", this.execution(running).context)) { await recordDenial(ports.audit, this.execution(running).context); return { status: "denied" }; }
      if (running.view.state === "completed" || running.view.state === "stopped") return this.viewOf(running, ports);
      const context = { ...this.execution(running).context, callId: `${caseRef}:phase-${this.execution(running).context.phaseId}:cancel` };
      running.view = { ...running.view, state: "stopped", stopReason: "cancelled" };
      this.endPhase(running, "stopped", ports);
      const notification = { ...context, deadline: running.cleanupDeadline!, signal: new AbortController().signal };
      const status = this.trackWork(running, context.phaseId, () => sendNotice(ports, notification,
        { kind: "status", state: "stopped", caseRef }, () => { if (this.retentionClosed() || this.auditBoundary?.hasLost(caseRef) || this.execution(running).context.phaseId !== context.phaseId) throw new Error("cancelled"); }));
      await Promise.allSettled([this.stopPhase(running, context, "cancel", ports), beforeDeadline(ports.clock, notification.deadline, () => status)]);
      return this.viewOf(running, ports);
    } catch { return { status: "denied" }; }
  }

  async get(actor: TrustedActor, caseRef: string, beforeDisclose?: (current: () => void, owner: SavedContext) => Promise<void>, signal?: AbortSignal): Promise<CaseView | { readonly status: "denied" }> {
    if (this.retentionClosed()) return { status: "denied" };
    const running = this.cases.get(caseRef);
    const ports = this.configured;
    if (!running) {
      const saved = await this.restoredView(actor, caseRef, "get", signal, beforeDisclose);
      return saved?.view ?? { status: "denied" };
    }
    if (!this.owns(actor, running)) { await this.denied(actor, caseRef); return { status: "denied" }; }
    try {
      if (!await ports.authorization.allows("get", this.execution(running).context)) { await recordDenial(ports.audit, this.execution(running).context); return { status: "denied" }; }
      const context = { ...this.execution(running).context, callId: `${caseRef}:get:${randomUUID()}` };
      await ports.audit.intent(context, "get");
      await ports.audit.complete(context, "get", "allowed");
      try { await beforeDisclose?.(() => { if (this.retentionClosed()) throw new Error("denied"); if (ports.authorization.current && ports.authorization.current("get", this.execution(running).context) !== true) throw new Error("denied"); }, this.execution(running).context); }
      catch { await recordDenial(ports.audit, context); return { status: "denied" }; }
      if (!await ports.authorization.allows("get", this.execution(running).context)) { await recordDenial(ports.audit, this.execution(running).context); return { status: "denied" }; }
      return this.viewOf(running, ports);
    } catch { return { status: "denied" }; }
  }

  private investigate(running: RunningCase, ports: Ports): Promise<void> {
    const phase = this.execution(running);
    const work = phase.produce(() => this.executeInvestigation(running, ports));
    void work.finally(() => beforeDeadline(ports.clock, running.cleanupDeadline ?? ports.clock.now() + CLEANUP_MS,
      () => phase.close())).catch(() => {});
    return work;
  }

  private async executeInvestigation(running: RunningCase, ports: Ports): Promise<void> {
    const phaseContext = this.execution(running).context;
    const phaseController = this.execution(running).controller;
    const phaseInbound = running.inbound;
    const target = running.target;
    if (!target) throw new Error("invalid_request");
    const psp = target.kind === "psp";
    const sourceRef = psp && this.scope.psp ? this.scope.psp.sourceRef : "simulator-source";
    const repositoryRef = psp && this.scope.psp ? this.scope.psp.repositoryRef : "simulator-source";
    const repositoryRefs = caseRepositories(phaseContext.resourceRefs);
    const investigation = running.investigation;
    let callSequence = 0;
    let evidenceSequence = 0;
    let safeInput: VerifiedInbound["input"];
    const assertCurrent = (allowEnded = false) => {
      if (this.retentionClosed()) throw new Error("cancelled");
      if (this.auditBoundary?.hasLost(phaseContext.caseRef)) throw new Error("audit_unavailable");
      if ((!allowEnded && !investigation.isCurrentPhase(phaseContext.phaseId)) || phaseController.signal.aborted || this.execution(running).context.phaseId !== phaseContext.phaseId) throw new Error("cancelled");
    };
    const contextFor = (action: string): CallContext => Object.freeze({ ...phaseContext, callId: `${phaseContext.caseRef}:phase-${phaseContext.phaseId}:${action}:${++callSequence}` });
    const guarded = async <T>(action: string, operation: (context: CallContext) => Promise<T>, acceptResult?: (result: T, auditRef: string) => void | Promise<void>,
      codeScope?: { readonly repositoryRef: string; readonly snapshotRef: string }): Promise<T> => {
      const assertAllowed = () => assertCurrent();
      if (ports.clock.now() >= phaseContext.deadline) throw new Error("timeout");
      assertAllowed();
      const cap = ["logs.read", "code.search", "code.snippet", "code.trace"].includes(action) ? TOOL_CALL_MS : CASE_EXECUTION_MS;
      const context = Object.freeze({ ...contextFor(action), deadline: Math.min(phaseContext.deadline, ports.clock.now() + cap) });
      const details: AuditDetails = action === "logs.read" ? { scope: { sourceRef, ...this.scope.queryWindow, pageSize: 100 } }
        : codeScope ? { scope: codeScope }
        : {};
      const check = () => { assertAllowed(); if (ports.clock.now() >= context.deadline) throw new Error("timeout"); };
      let invoked = false;
      const work = async () => {
        if (!await ports.authorization.allows(action, context)) { await recordDenial(ports.audit, context); throw new Error("denied"); }
        check();
        let auditRef: string;
        try { auditRef = await ports.audit.intent(context, action, details); } catch { throw new Error("audit_unavailable"); }
        check();
        invoked = true;
        const discarded = () => phaseController.signal.aborted || this.execution(running).context.phaseId !== phaseContext.phaseId || ports.clock.now() >= context.deadline;
        let output: T;
        try { output = await operation(context); }
        catch (error) {
          if (error instanceof Error && error.message === "audit_unavailable") {
            this.auditBoundary?.fail(context, action, "complete");
            throw new Error("audit_unavailable");
          }
          try { await ports.audit.complete(context, action, discarded() ? "discarded" : "failed"); } catch { throw new Error("audit_unavailable"); }
          throw error;
        }
        if (discarded()) {
          try { await ports.audit.complete(context, action, "discarded"); } catch { throw new Error("audit_unavailable"); }
          check();
        }
        let result: T;
        try {
          if (action === "agent.run" && !ports.sanitization.safe(output)) throw new Error("unsafe_content");
          result = ports.sanitization.sanitize(output, context.caseRef);
          if (!ports.sanitization.safe(result)) throw new Error("unsafe_content");
        } catch (error) {
          try { await ports.audit.complete(context, action, "rejected"); } catch { throw new Error("audit_unavailable"); }
          throw error;
        }
        if (["logs.read", "code.search", "code.snippet", "code.trace"].includes(action)) {
          await this.saveRecord(running, context, ports, { recordRef: `${context.callId}:output`, schemaVersion: 1,
            kind: "tool_result", payload: result });
        }
        const read = result as Partial<ReadResult<unknown>> | null;
        const completeDetails: AuditDetails = ["logs.read", "code.search", "code.snippet", "code.trace"].includes(action) && read && Array.isArray(read.evidence)
          ? { ...details, result: { completeness: ["complete", "partial", "unknown"].includes(read.completeness ?? "") ? read.completeness! : "unknown",
            truncated: read.truncated === true, evidenceCount: read.evidence.length } } : details;
        try { await ports.audit.complete(context, action, "ok", completeDetails); } catch { throw new Error("audit_unavailable"); }
        check();
        await acceptResult?.(result, auditRef);
        if (["logs.read", "code.search", "code.snippet", "code.trace"].includes(action)) check();
        return result;
      };
      const start = () => {
        return this.trackWork(running, context.phaseId, work);
      };
      try { return await beforeDeadline(ports.clock, context.deadline, start, phaseController.signal); }
      catch (error) {
        if (invoked && (phaseController.signal.aborted || ports.clock.now() >= context.deadline)) {
          void beforeDeadline(ports.clock, running.cleanupDeadline ?? ports.clock.now() + CLEANUP_MS, () => this.trackWork(running, context.phaseId, async () => {
            await ports.audit.complete(context, action, "unknown");
          })).catch(() => {});
        }
        if (this.execution(running).context.phaseId === phaseContext.phaseId && running.view.state === "investigating") {
          const reason = safeReason(error);
          running.view = { ...running.view, state: "stopped", stopReason: reason };
          this.endPhase(running, "stopped", ports);
          void this.stopPhase(running, phaseContext, reason, ports);
        }
        throw error;
      }
    };
    const acceptEvidence = async (read: ReadResult<unknown>, kind: "log" | "code", auditRef: string) => {
      if (!read || !["complete", "partial", "unknown"].includes(read.completeness) || !Array.isArray(read.evidence)) throw new Error("schema_mismatch");
      if (!Array.isArray(read.warnings) || read.warnings.some((warning) => typeof warning !== "string")) throw new Error("schema_mismatch");
      investigation.acceptWarnings(read.warnings);
      if (!read.evidence.length && (read.completeness !== "complete" || read.truncated)) {
        investigation.acceptWarnings([`${kind}: ${read.completeness}; truncated=${read.truncated}; zero observations.`]);
      }
      const targetRef = kind === "log" ? (read.value as SimulatorObservation | null)?.applicationRef : target.applicationRef;
      if (kind === "log" && targetRef && targetRef !== target.applicationRef) throw new Error("invalid_request");
      const acceptedRefs: string[] = [];
      for (const [index, item] of read.evidence.entries()) {
        if (item.kind !== kind || (kind === "log" ? item.sourceRef !== sourceRef : !repositoryRefs.includes(item.sourceRef))) throw new Error("schema_mismatch");
        if (targetRef && item.targetRef !== targetRef) throw new Error("invalid_request");
        if (kind === "code" && (item.code?.snapshotRef !== phaseContext.snapshotRef ||
          !repositoryRefs.includes(item.code.repositoryRef) || !["main", "master"].includes(item.code.branch) ||
          !/^[a-f0-9]{40}$/.test(item.code.commit) || !item.code.receiptRef)) throw new Error("version_mismatch");
        const evidence = { ...item, completeness: read.completeness, truncated: item.truncated || read.truncated,
          evidenceRef: `${phaseContext.caseRef}:phase-${phaseContext.phaseId}:${kind}:${++evidenceSequence}:${index}`, caseRef: phaseContext.caseRef,
          sanitizationVersion: "mock-sanitization-1", auditRef };
        await this.saveRecord(running, phaseContext, ports, { recordRef: evidence.evidenceRef, schemaVersion: 1, kind: "evidence", payload: evidence });
        assertCurrent();
        investigation.acceptEvidence(evidence); acceptedRefs.push(evidence.evidenceRef);
      }
      return acceptedRefs;
    };
    const waitForInformation = async (question: InformationQuestion): Promise<never> => {
      const informationContext = contextFor("requestInformation");
      try {
        await ports.audit.intent(informationContext, "requestInformation");
        await ports.audit.complete(informationContext, "requestInformation", "awaiting_input");
      } catch { throw new Error("audit_unavailable"); }
      assertCurrent();
      if (ports.clock.now() >= phaseContext.deadline) throw new Error("timeout");
      const status = await beforeDeadline(ports.clock, phaseContext.deadline, () => this.trackWork(running, phaseContext.phaseId, () => sendNotice(ports, phaseContext,
        { kind: "question", caseRef: phaseContext.caseRef, question }, () => { assertCurrent(); if (ports.clock.now() >= phaseContext.deadline) throw new Error("timeout"); })), phaseController.signal);
      if (status !== "delivered") throw new Error("unavailable");
      investigation.awaitInformation();
      running.cancelDeadline?.();
      phaseController.abort();
      const { deadlineAt: _deadline, ...withoutDeadline } = running.view;
      running.view = { ...withoutDeadline, state: "awaiting_input", waitingStartedAt: ports.clock.utc(), question, inputWaits: [...running.view.inputWaits, { questionId: `${phaseContext.caseRef}:question:${phaseContext.phaseId}`, startedAt: ports.clock.utc() }] };
      this.endPhase(running, "awaiting_input", ports);
      void this.execution(running, phaseContext.phaseId).abort().catch(() => {});
      throw new Error("awaiting_input");
    };
    const invoke = async (tool: string, query: unknown): Promise<unknown> => {
      if (tool === "logs.read") {
        if (query !== null) throw new Error("invalid_request");
        if (running.view.usage.logRecords >= MAX_LOG_RECORDS) throw new Error("budget_exhausted");
        let rawRead: LogRead | undefined;
        let logAuditRef = "";
        const read = await guarded("logs.read", async (context) => {
          const result = await ports.logs.read(context, {
            sourceRef, ...target.query(),
            from: this.scope.queryWindow.from, to: this.scope.queryWindow.to, pageSize: 100,
          });
          assertCurrent();
          if (ports.clock.now() >= context.deadline) throw new Error("timeout");
          if (!Array.isArray(result.evidence)) throw new Error("schema_mismatch");
          const windowKey = `${this.scope.queryWindow.from}/${this.scope.queryWindow.to}`;
          const newCoverage = running.coverageWindows.has(windowKey) ? 0
            : Date.parse(this.scope.queryWindow.to) - Date.parse(this.scope.queryWindow.from);
          running.coverageWindows.add(windowKey);
          running.view = { ...running.view, usage: { ...running.view.usage,
            logRecords: running.view.usage.logRecords + result.evidence.length,
            logCoverageMs: running.view.usage.logCoverageMs + newCoverage } };
          await this.saveView(running, ports);
          rawRead = structuredClone(result);
          return result;
        }, (_read, auditRef) => { logAuditRef = auditRef; });
        if (!rawRead) throw new Error("invalid_request");
        const resolution = target.resolve(rawRead, read, `${phaseContext.caseRef}:question:${phaseContext.phaseId}`);
        if (resolution.kind === "selected") {
          if (target.applicationRef) investigation.selectTarget(target.applicationRef);
          return invoke("logs.read", null);
        }
        if (resolution.kind === "question") return waitForInformation(resolution.question);
        const observationRefs = await acceptEvidence(read, "log", logAuditRef);
        target.accept(read, observationRefs, investigation);
        return read;
      }
      if (tool === "code.search" || tool === "code.snippet" || tool === "code.trace") {
        const operation = tool.slice(5) as "search" | "snippet" | "trace";
        if (query !== null && (typeof query !== "object" || Array.isArray(query) || "snapshotRef" in query)) throw new Error("invalid_request");
        const bound = codeQuery(operation, { ...(query ?? { repositoryRef, ...(psp && operation === "search" ? { term: "verifyPsp" } : {}) }), snapshotRef: phaseContext.snapshotRef });
        if (!repositoryRefs.includes(bound.repositoryRef) || ("targetRepositoryRef" in bound && bound.targetRepositoryRef &&
          !repositoryRefs.includes(bound.targetRepositoryRef))) throw new Error("denied");
        return guarded(tool, (context) => operation === "search" ? ports.code.search(context, bound as CodeSearchQuery)
          : operation === "snippet" ? ports.code.snippet(context, bound as CodeSnippetQuery) : ports.code.trace(context, bound as CodeTraceQuery),
          async (read, auditRef) => { await acceptEvidence(read, "code", auditRef); },
          { repositoryRef: bound.repositoryRef, snapshotRef: bound.snapshotRef });
      }
      throw new Error("denied");
    };
    let draft: DiagnosticReport | undefined;
    let draftVersion = -1;
    const diagnose = (): DiagnosticReport => {
      if (!draft || draftVersion !== investigation.materialVersion) {
        draft = target.diagnose(investigation, safeInput.question, ports.clock.utc());
        draftVersion = investigation.materialVersion;
      }
      return draft;
    };
    try {
      assertCurrent();
      safeInput = ports.sanitization.sanitize(phaseInbound.input, phaseContext.caseRef);
      if (!ports.sanitization.safe(safeInput)) throw new Error("unsafe_content");
      const status = await beforeDeadline(ports.clock, phaseContext.deadline, () => this.trackWork(running, phaseContext.phaseId, () => sendNotice(ports, phaseContext, { kind: "status", state: "accepted", caseRef: phaseContext.caseRef }, () => {
        assertCurrent(); if (ports.clock.now() >= phaseContext.deadline) throw new Error("timeout");
      })), phaseController.signal);
      if (status !== "delivered") throw new Error("unavailable");
      if (target.applicationRef) investigation.selectTarget(target.applicationRef);
      const model = new ModelExecution(ports, this.scope, this.execution(running, phaseContext.phaseId), {
        current: () => assertCurrent(),
        admit: async (context, envelope) => {
          if (running.view.usage.modelAttempts >= MAX_MODEL_ATTEMPTS) throw new Error("budget_exhausted");
          running.view = { ...running.view, usage: { ...running.view.usage, modelAttempts: running.view.usage.modelAttempts + 1 } };
          await this.saveRecord(running, context, ports, { recordRef: `${context.callId}:input`, schemaVersion: 1, kind: "model_input", payload: envelope });
          await this.saveView(running, ports);
        },
        save: (context, record) => this.saveRecord(running, context, ports, record),
        stop: (error) => {
          if (this.execution(running).context.phaseId !== phaseContext.phaseId || running.view.state !== "investigating") return;
          const reason = safeReason(error);
          running.view = { ...running.view, state: "stopped", stopReason: reason };
          this.endPhase(running, "stopped", ports);
          void this.stopPhase(running, phaseContext, reason, ports);
        },
      }, () => contextFor("model.generate").callId);
      const candidate = await guarded("agent.run", (context) => ports.agent.run(context, {
        question: safeInput.question, invoke, diagnose,
        progress: (value) => {
          assertCurrent();
          if (!boundedBody(value) || !ports.sanitization.safe(ports.sanitization.sanitize(value, phaseContext.caseRef))) throw new Error("unsafe_content");
          // Progress is deliberately not retained or forwarded and never changes any deadline.
        },
        generate: (turn) => model.generate(turn),
      }));
      if (!ports.sanitization.safe(candidate)) throw new Error("unsafe_content");
      const report = investigation.finish(candidate, diagnose());
      await this.saveRecord(running, phaseContext, ports, { recordRef: report.reportRef, schemaVersion: 1, kind: "report", payload: report });
      running.view = { ...running.view, deliveryStatus: "unknown" };
      const deliveryStatus = await beforeDeadline(ports.clock, phaseContext.deadline, () => this.trackWork(running, phaseContext.phaseId,
        () => sendReport(ports, contextFor("delivery.send"), report, () => assertCurrent(true))), phaseController.signal);
      running.view = { ...running.view, state: "completed", reportRef: report.reportRef, deliveryStatus };
      this.endPhase(running, "completed", ports);
    } catch (error: unknown) {
      const reason = safeReason(error);
      if (this.execution(running).context.phaseId === phaseContext.phaseId && running.view.state === "investigating") {
        running.view = { ...running.view, state: "stopped", stopReason: reason };
        this.endPhase(running, "stopped", ports);
        await this.stopPhase(running, phaseContext, reason, ports);
      }
    }
  }
}
