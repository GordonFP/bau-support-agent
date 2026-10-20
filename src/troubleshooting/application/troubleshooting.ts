import { createHash, randomUUID } from "node:crypto";
import { TroubleshootingCase } from "../domain/simulator.js";
import { boundedBody, CASE_EXECUTION_MS, CASE_MODEL_MICROUSD, CLEANUP_MS, MAX_ACTIVE_CASES, MAX_LOG_RECORDS, MAX_MODEL_ATTEMPTS, MODEL_CALL_MS, TOOL_CALL_MS, phaseWindow } from "./limits.js";
import { beforeDeadline, schedule } from "./deadline.js";
import type { DiagnosticReport, SimulatorObservation } from "../domain/simulator.js";
import type { Acceptance, ApplicationCandidates, CallContext, CaseView, InformationReply, InformationResult, Ports, ReadResult, SafeReason, TrustedActor, VerifiedInbound } from "./ports.js";
import type { AuditDetails, CaseRecord } from "./records.js";
import { AuditBoundary } from "./audit-boundary.js";
import { deniedContext, recordDenial } from "./authorization-audit.js";
import { modelEnvelope, validateModelResponse } from "./model-envelope.js";
import type { ModelPolicy } from "./model-contract.js";
import { ModelFailure } from "./model-failure.js";
import { retryModel } from "./model-retry.js";

const reasons = new Set<SafeReason>(["denied", "invalid_request", "contract_unverified", "schema_mismatch", "unavailable",
  "timeout", "cancelled", "rate_limited", "budget_exhausted", "version_unknown", "version_mismatch", "unsafe_content", "audit_unavailable"]);
const requiredPorts = ["admission", "records", "clock", "authorization", "sanitization", "audit", "budget", "logs", "code", "agent", "model", "delivery"] as const;
const safeReason = (error: unknown): SafeReason => error instanceof Error && reasons.has(error.message as SafeReason)
  ? error.message as SafeReason : "unavailable";

interface RunningCase {
  inbound: VerifiedInbound;
  controller: AbortController;
  context: CallContext;
  readonly investigation: TroubleshootingCase;
  replyTail: Promise<void>;
  readonly replyFlights: Map<string, Promise<InformationResult>>;
  readonly replyEvents: Set<string>;
  readonly coverageWindows: Set<string>;
  readonly modelHistory: unknown[];
  readonly modelTools: unknown[];
  readonly acceptedMono: number;
  finishedMono?: number;
  recordSequence: number;
  cleanupDeadline?: number;
  readonly closures: Map<number, Promise<void>>;
  readonly stopping: Map<number, Promise<void>>;
  cancelDeadline?: () => void;
  candidates?: ApplicationCandidates["candidates"];
  targetSubmittedOn?: string;
  view: CaseView;
}

export interface OfflineScope {
  readonly mode: "mock";
  readonly snapshotRef: string;
  readonly queryWindow: { readonly from: string; readonly to: string };
  readonly modelPolicy?: ModelPolicy;
}

export class Troubleshooting {
  private readonly cases = new Map<string, RunningCase>();
  private readonly acceptances = new Map<string, Promise<Acceptance>>();
  private readonly pendingAdmissions = new Set<string>();
  private readonly persistedLookups = new Map<string, Promise<Acceptance | null>>();
  private sequence = 0;
  private readonly auditBoundary?: AuditBoundary;

  constructor(private readonly configured: Partial<Ports>, private readonly scope?: OfflineScope) {
    if (configured.audit) {
      this.auditBoundary = new AuditBoundary(configured.audit, (context, action, stage) => this.auditFailure(context, action, stage));
      this.configured = { ...configured, audit: this.auditBoundary.port };
    }
  }

  async accept(inbound: VerifiedInbound): Promise<Acceptance> {
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
      if (running.context.principalRef !== inbound.principalRef) {
        await this.denied(inbound, accepted.view.caseRef);
        return { status: "denied", reason: "denied" };
      }
      try {
        if (!await this.configured.authorization!.allows("accept", running.context)) {
          await recordDenial(this.configured.audit!, running.context);
          return { status: "denied", reason: "denied" };
        }
        return { status: "duplicate", view: this.viewOf(running, this.configured as Ports) };
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
    const ports = this.configured as Ports;
    if (!ports.clock || !ports.records || this.persistedLookups.size + this.pendingAdmissions.size >= MAX_ACTIVE_CASES) {
      return { status: "service_unavailable", reason: "unavailable" };
    }
    const deadline = originalDeadline ?? ports.clock.now() + CASE_EXECUTION_MS;
    let expired = false;
    const work = (async (): Promise<Acceptance | null> => {
      const found = caseRef ? { caseRef } : await ports.admission.lookup!(key);
      if (expired || ports.clock.now() >= deadline) throw new Error("timeout");
      if (!found) return null;
      const saved = await ports.records.read(inbound, found.caseRef);
      return saved ? { status: "duplicate", view: saved.view } : { status: "denied", reason: "denied" };
    })();
    const operation = beforeDeadline(ports.clock, deadline, () => work, undefined, () => { expired = true; })
      .catch((): Acceptance => ({ status: "service_unavailable", reason: expired ? "timeout" : "unavailable" }));
    this.persistedLookups.set(flightKey, operation);
    void work.finally(() => this.persistedLookups.delete(flightKey)).catch(() => {});
    return operation;
  }

  private async acceptVerified(inbound: VerifiedInbound, key: string, admissionPhase?: ReturnType<typeof phaseWindow>): Promise<Acceptance> {
    if (requiredPorts.some((key) => !this.configured[key]) || this.scope?.mode !== "mock") return { status: "service_unavailable", reason: "unavailable" };
    const windowSize = Date.parse(this.scope.queryWindow.to) - Date.parse(this.scope.queryWindow.from);
    if (!this.scope.snapshotRef || !Number.isFinite(windowSize) || windowSize <= 0 || windowSize > 86_400_000) {
      return { status: "service_unavailable", reason: "invalid_request" };
    }
    const ports = this.configured as Ports;
    if (!inbound || inbound.conversationKind !== "private" || !inbound.eventRef || !inbound.tenantRef ||
        !inbound.principalRef || !inbound.destinationRef ||
        ![inbound.input?.applicationId, inbound.input?.customerId].some((id) => typeof id === "string" && id.length > 0) ||
        (inbound.input.applicationId !== undefined && inbound.input.customerId !== undefined) ||
        typeof inbound.input.question !== "string" || !Number.isFinite(Date.parse(inbound.receivedAt))) {
      return { status: "denied", reason: "invalid_request" };
    }
    const caseRef = ports.admission.allocateCaseRef?.() ?? `case-${++this.sequence}`;
    const controller = new AbortController();
    const phase = admissionPhase ?? phaseWindow(ports.clock);
    const now = phase.startedAt;
    const context: CallContext = Object.freeze({ caseRef, phaseId: 1, callId: `${caseRef}:accept`, principalRef: inbound.principalRef,
      tenantRef: inbound.tenantRef, destinationRef: inbound.destinationRef, policyVersion: "mock-policy-1", approvalRef: "mock-approval-1",
      resourceRefs: Object.freeze(["simulator-source"]), snapshotRef: this.scope.snapshotRef, budgetRef: caseRef,
      deadline: phase.deadline, signal: controller.signal });
    const work = this.confirmAcceptance(inbound, key, ports, context, controller, phase);
    void work.finally(() => this.pendingAdmissions.delete(key)).catch(() => {});
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
    controller: AbortController, phase: ReturnType<typeof phaseWindow>): Promise<Acceptance> {
    const caseRef = context.caseRef;
    const now = phase.startedAt;
    const check = () => { if (controller.signal.aborted || ports.clock.now() >= context.deadline) throw new Error("timeout"); };
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
    const running: RunningCase = { inbound: structuredClone(inbound), context, controller, view, investigation,
      replyTail: Promise.resolve(), replyFlights: new Map(), closures: new Map(), stopping: new Map(), replyEvents: new Set(), coverageWindows: new Set(),
      modelHistory: [], modelTools: [], recordSequence: 0, acceptedMono: context.deadline - CASE_EXECUTION_MS };
    let admitted = false;
    try {
      const confirmation = await ports.admission.confirm({ key, caseRef, principalRef: context.principalRef,
        initial: { context, view, input: safeInput } });
      if (confirmation.status === "full") return { status: "service_unavailable", reason: "unavailable" };
      if (confirmation.status === "duplicate") {
        const existing = this.cases.get(confirmation.caseRef);
        if (!existing && confirmation.principalRef === context.principalRef) {
          const saved = await ports.records.read(inbound, confirmation.caseRef);
          if (saved) return { status: "duplicate", view: saved.view };
        }
        return existing && confirmation.principalRef === context.principalRef && this.owns(inbound, existing) &&
          await ports.authorization.allows("accept", existing.context)
          ? { status: "duplicate", view: this.viewOf(existing, ports) } : { status: "service_unavailable", reason: "unavailable" };
      }
      admitted = true;
    } catch { return { status: "service_unavailable", reason: "unavailable" }; }
    finally { if (!admitted) { try { ports.sanitization.clear(caseRef); } catch { /* candidate was not accepted */ } } }
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

  async provideInformation(reply: InformationReply): Promise<InformationResult> {
    if (!boundedBody({ reply: reply?.reply, content: reply?.content })) return { status: "denied", reason: "invalid_request" };
    try { reply = structuredClone(reply); } catch { return { status: "denied", reason: "invalid_request" }; }
    const running = this.cases.get(reply?.reply?.caseRef);
    if (!running || reply.principalRef !== running.context.principalRef || reply.tenantRef !== running.context.tenantRef ||
      reply.destinationRef !== running.context.destinationRef) {
      await this.denied(reply, reply?.reply?.caseRef ?? "unresolved");
      return { status: "denied", reason: "denied" };
    }
    const previous = running.replyFlights.get(reply.eventRef);
    if (previous) {
      await previous;
      try {
        if (!await this.configured.authorization!.allows("provideInformation", running.context)) return { status: "denied", reason: "denied" };
        return { status: "duplicate", view: this.viewOf(running, this.configured as Ports) };
      } catch { return { status: "denied", reason: "unavailable" }; }
    }
    if (running.replyFlights.size >= MAX_ACTIVE_CASES) return { status: "denied", reason: "rate_limited" };
    const operation = running.replyTail.then(() => this.resumeFromInformation(running, reply, this.configured as Ports));
    running.replyFlights.set(reply.eventRef, operation);
    running.replyTail = operation.then(() => {}, () => {});
    try { return await operation; } finally { running.replyFlights.delete(reply.eventRef); }
  }

  private async resumeFromInformation(running: RunningCase, reply: InformationReply, ports: Ports): Promise<InformationResult> {
    try {
      if (!await ports.authorization.allows("provideInformation", running.context)) { await recordDenial(ports.audit, running.context); return { status: "denied", reason: "denied" }; }
      if (running.replyEvents.has(reply.eventRef)) return { status: "duplicate", view: this.viewOf(running, ports) };
      if (running.view.state === "completed" || running.view.state === "stopped") return { status: "terminal", view: this.viewOf(running, ports), newCaseRequired: true };
      if (reply.content && ("applicationId" in reply.content || "customerId" in reply.content)) {
        return { status: "denied", reason: "invalid_request", newCaseRequired: true };
      }
      if (running.view.state !== "awaiting_input" || running.view.question?.questionId !== reply.reply.questionId ||
        !reply.eventRef || !Number.isFinite(Date.parse(reply.receivedAt))) return { status: "denied", reason: "invalid_request" };
      const matches = (running.candidates ?? []).filter((candidate, index) => candidate.submittedAt === reply.content.submittedAt &&
        (reply.content.candidateRef === undefined || reply.content.candidateRef === `candidate-${index + 1}`));
      if (matches.length !== 1 || Object.keys(reply.content).some((key) => !["submittedAt", "candidateRef"].includes(key))) {
        running.replyEvents.add(reply.eventRef);
        return { status: "needs_information", view: this.viewOf(running, ports) };
      }
      const candidate = matches[0]!;
      const context = { ...running.context, callId: `${running.context.caseRef}:reply:${reply.eventRef}` };
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
      running.investigation.selectTarget(ports.sanitization.sanitize(candidate.applicationId, context.caseRef));
      const phaseId = running.investigation.resume();
      const controller = new AbortController();
      const phase = phaseWindow(ports.clock);
      const startedAt = phase.startedAt;
      running.context = Object.freeze({ ...running.context, phaseId, callId: `${context.caseRef}:phase-${phaseId}:start`,
        deadline: phase.deadline, signal: controller.signal });
      running.controller = controller;
      running.inbound = { ...running.inbound, input: { applicationId: candidate.applicationId, question: running.inbound.input.question } };
      running.targetSubmittedOn = candidate.submittedAt.slice(0, 10);
      const { question: _question, waitingStartedAt: _waiting, ...view } = running.view;
      running.view = { ...view, phaseId, state: "investigating", phaseStartedAt: startedAt,
        deadlineAt: phase.deadlineAt,
        phases: [...view.phases, { phaseId, startedAt }],
        inputWaits: view.inputWaits.map((wait) => wait.questionId === reply.reply.questionId
          ? { ...wait, endedAt: startedAt, replyEventRef: reply.eventRef, replyReceivedAt: reply.receivedAt } : wait) };
      running.replyEvents.add(reply.eventRef);
      await this.saveView(running, ports);
      this.armDeadline(running, ports);
      void this.investigate(running, ports);
      return { status: "resumed", view: this.viewOf(running, ports) };
    } catch { return { status: "denied", reason: "unavailable" }; }
  }

  private viewOf(running: RunningCase, ports: Ports): CaseView {
    const initialDelay = Math.max(0, Date.parse(running.view.acceptedAt) - Date.parse(running.view.receivedAt));
    return structuredClone({ ...running.view, elapsedMs: initialDelay + (running.finishedMono ?? ports.clock.now()) - running.acceptedMono });
  }

  private async saveRecord(running: RunningCase, context: CallContext, ports: Ports, record: CaseRecord): Promise<void> {
    try { await ports.records.append(context, record); }
    catch { this.auditBoundary?.fail(context, "records.append", "complete"); throw new Error("audit_unavailable"); }
  }

  private saveView(running: RunningCase, ports: Ports): Promise<void> {
    return this.saveRecord(running, running.context, ports, { recordRef: `${running.context.caseRef}:view:${++running.recordSequence}`,
      schemaVersion: 1, kind: "view", payload: this.viewOf(running, ports) });
  }

  private auditFailure(context: CallContext, action: string, stage: "intent" | "complete"): void {
    const running = this.cases.get(context.caseRef);
    if (!running) return;
    const ports = this.configured as Ports;
    if (running.view.state === "investigating" || running.view.state === "awaiting_input") {
      running.view = { ...running.view, state: "stopped", stopReason: "audit_unavailable" };
      this.endPhase(running, "stopped", ports);
    }
    void this.stopPhase(running, running.context, "audit_unavailable", ports);
    if (stage !== "complete" && action !== "delivery.send") return;
    const current = running.context;
    void beforeDeadline(ports.clock, running.cleanupDeadline ?? ports.clock.now() + CLEANUP_MS, async () => {
      if (!await ports.authorization.allows("delivery.fault", current)) return;
      if (ports.clock.now() >= (running.cleanupDeadline ?? 0)) return;
      await ports.delivery.fault(current.destinationRef, "Investigation stopped because audit storage is unavailable.", `${current.caseRef}:audit-fault`);
    }).catch(() => {});
  }

  private endPhase(running: RunningCase, outcome: "awaiting_input" | "completed" | "stopped", ports: Ports): void {
    running.view = { ...running.view, phases: running.view.phases.map((phase) => phase.phaseId === running.context.phaseId && !phase.endedAt
      ? { ...phase, endedAt: ports.clock.utc(), outcome } : phase) };
    if (outcome !== "awaiting_input") {
      running.investigation.stop();
      running.finishedMono ??= ports.clock.now();
      running.cleanupDeadline ??= ports.clock.now() + CLEANUP_MS;
      running.cancelDeadline?.();
      running.controller.abort();
      try { ports.sanitization.clear(running.context.caseRef); } catch { /* no raw cleanup errors leave the host */ }
      running.inbound = { ...running.inbound, input: { question: "" } };
      delete running.candidates;
      running.modelHistory.length = 0;
      running.modelTools.length = 0;
      void ports.admission.release(running.context.caseRef).catch(() => {});
    }
    void ports.records.append(running.context, { recordRef: `${running.context.caseRef}:view:${++running.recordSequence}`,
      schemaVersion: 1, kind: "view", payload: this.viewOf(running, ports) })
      .catch(() => this.auditBoundary?.fail(running.context, "records.append", "complete"));
  }

  private armDeadline(running: RunningCase, ports: Ports): void {
    running.cancelDeadline?.();
    const context = running.context;
    const controller = running.controller;
    const expire = () => {
      if (running.context.phaseId !== context.phaseId || running.view.state !== "investigating" ||
        controller.signal.aborted || ports.clock.now() < context.deadline) return;
      running.view = { ...running.view, state: "stopped", stopReason: "timeout" };
      this.endPhase(running, "stopped", ports);
      void this.stopPhase(running, context, "timeout", ports);
    };
    running.cancelDeadline = schedule(ports.clock, context.deadline, expire);
  }

  private closePhase(running: RunningCase, context: CallContext, ports: Ports): Promise<void> {
    const previous = running.closures.get(context.phaseId);
    if (previous) return previous;
    const operation = beforeDeadline(ports.clock, running.cleanupDeadline ?? ports.clock.now() + CLEANUP_MS,
      () => ports.agent.close(context.caseRef, context.phaseId)).catch(() => {});
    running.closures.set(context.phaseId, operation);
    return operation;
  }

  private stopPhase(running: RunningCase, context: CallContext, reason: string, ports: Ports): Promise<void> {
    const previous = running.stopping.get(context.phaseId);
    if (previous) return previous;
    const deadline = running.cleanupDeadline ?? ports.clock.now() + CLEANUP_MS;
    const operation = beforeDeadline(ports.clock, deadline, async () => {
      if (this.auditBoundary?.hasLost(context.caseRef)) {
        await Promise.allSettled([ports.agent.abort(context.caseRef, context.phaseId), this.closePhase(running, context, ports)]);
        return;
      }
      const audit = { ...context, callId: `${context.caseRef}:phase-${context.phaseId}:${reason}` };
      try { await ports.audit.intent(audit, reason); } catch { /* local stop remains effective */ }
      if (ports.clock.now() >= deadline) return;
      await Promise.allSettled([ports.agent.abort(context.caseRef, context.phaseId), this.closePhase(running, context, ports),
        ports.audit.complete(audit, reason, "stopped")]);
    }).catch(() => {});
    running.stopping.set(context.phaseId, operation);
    return operation;
  }

  private owns(actor: TrustedActor, running: RunningCase): boolean {
    return !!actor && actor.principalRef === running.context.principalRef && actor.tenantRef === running.context.tenantRef && actor.destinationRef === running.context.destinationRef;
  }

  private async denied(actor: TrustedActor, caseRef: string): Promise<void> {
    const ports = this.configured as Ports;
    try { await recordDenial(ports.audit, deniedContext(actor, caseRef, ports)); } catch { /* no disclosure follows denial */ }
  }

  async cancel(actor: TrustedActor, caseRef: string): Promise<CaseView | { readonly status: "denied" }> {
    const running = this.cases.get(caseRef);
    const ports = this.configured as Ports;
    if (!running || !this.owns(actor, running)) { await this.denied(actor, caseRef); return { status: "denied" }; }
    try {
      if (!await ports.authorization.allows("cancel", running.context)) { await recordDenial(ports.audit, running.context); return { status: "denied" }; }
      if (running.view.state === "completed" || running.view.state === "stopped") return this.viewOf(running, ports);
      const context = { ...running.context, callId: `${caseRef}:phase-${running.context.phaseId}:cancel` };
      running.view = { ...running.view, state: "stopped", stopReason: "cancelled" };
      this.endPhase(running, "stopped", ports);
      await this.stopPhase(running, context, "cancel", ports);
      return this.viewOf(running, ports);
    } catch { return { status: "denied" }; }
  }

  async get(actor: TrustedActor, caseRef: string): Promise<CaseView | { readonly status: "denied" }> {
    const running = this.cases.get(caseRef);
    const ports = this.configured as Ports;
    if (!running) {
      try { const saved = await ports.records.read(actor, caseRef); return saved?.view ?? { status: "denied" }; }
      catch { return { status: "denied" }; }
    }
    if (!this.owns(actor, running)) { await this.denied(actor, caseRef); return { status: "denied" }; }
    try {
      if (!await ports.authorization.allows("get", running.context)) { await recordDenial(ports.audit, running.context); return { status: "denied" }; }
      const context = { ...running.context, callId: `${caseRef}:get:${randomUUID()}` };
      await ports.audit.intent(context, "get");
      await ports.audit.complete(context, "get", "allowed");
      return this.viewOf(running, ports);
    } catch { return { status: "denied" }; }
  }

  private async investigate(running: RunningCase, ports: Ports): Promise<void> {
    const phaseContext = running.context;
    const phaseController = running.controller;
    const phaseInbound = running.inbound;
    const investigation = running.investigation;
    let observation: SimulatorObservation | null = null;
    let callSequence = 0;
    let evidenceSequence = 0;
    let safeInput: VerifiedInbound["input"];
    let selectedApplicationId = phaseInbound.input.applicationId;
    let selectedApplicationRef: string | undefined;
    let selectedSubmittedOn = running.targetSubmittedOn;
    const assertCurrent = (allowEnded = false) => {
      if (this.auditBoundary?.hasLost(phaseContext.caseRef)) throw new Error("audit_unavailable");
      if ((!allowEnded && !investigation.isCurrentPhase(phaseContext.phaseId)) || phaseController.signal.aborted || running.context.phaseId !== phaseContext.phaseId) throw new Error("cancelled");
    };
    const contextFor = (action: string): CallContext => Object.freeze({ ...phaseContext, callId: `${phaseContext.caseRef}:phase-${phaseContext.phaseId}:${action}:${++callSequence}` });
    const guarded = async <T>(action: string, operation: (context: CallContext) => Promise<T>, acceptResult?: (result: T, auditRef: string) => void | Promise<void>,
      attempt?: { callId: string; operationRef: string; deadline: number; recoverable: (error: unknown) => boolean }): Promise<T> => {
      const assertAllowed = () => assertCurrent(action === "delivery.send");
      if (ports.clock.now() >= phaseContext.deadline) throw new Error("timeout");
      assertAllowed();
      const cap = action === "model.generate" ? MODEL_CALL_MS : ["logs.read", "code.search"].includes(action) ? TOOL_CALL_MS : CASE_EXECUTION_MS;
      const context = Object.freeze({ ...(attempt ? { ...phaseContext, callId: attempt.callId, operationRef: attempt.operationRef } : contextFor(action)),
        deadline: Math.min(phaseContext.deadline, attempt?.deadline ?? ports.clock.now() + cap) });
      const details: AuditDetails = action === "logs.read" ? { scope: { sourceRef: "simulator-source", ...this.scope!.queryWindow, pageSize: 100 } }
        : action === "code.search" ? { scope: { repositoryRef: "simulator-source", snapshotRef: phaseContext.snapshotRef } }
        : action === "delivery.send" ? { delivery: { deliveryKey: `${phaseContext.caseRef}:report:1`, segment: 1 } } : {};
      const check = () => { assertAllowed(); if (ports.clock.now() >= context.deadline) throw new Error("timeout"); };
      let invoked = false;
      const work = async () => {
        if (!await ports.authorization.allows(action, context)) { await recordDenial(ports.audit, context); throw new Error("denied"); }
        check();
        let auditRef: string;
        try { auditRef = await ports.audit.intent(context, action, details); } catch { throw new Error("audit_unavailable"); }
        check();
        invoked = true;
        const discarded = () => phaseController.signal.aborted || running.context.phaseId !== phaseContext.phaseId || ports.clock.now() >= context.deadline;
        let output: T;
        try { output = await operation(context); }
        catch (error) {
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
        if (["logs.read", "code.search", "model.generate"].includes(action)) {
          await this.saveRecord(running, context, ports, { recordRef: `${context.callId}:output`, schemaVersion: 1,
            kind: action === "model.generate" ? "model_output" : "tool_result", payload: result });
        }
        const read = result as Partial<ReadResult<unknown>> | null;
        let completeDetails: AuditDetails = ["logs.read", "code.search"].includes(action) && read && Array.isArray(read.evidence)
          ? { ...details, result: { completeness: ["complete", "partial", "unknown"].includes(read.completeness ?? "") ? read.completeness! : "unknown",
            truncated: read.truncated === true, evidenceCount: read.evidence.length } } : details;
        if (action === "delivery.send" && ["delivered", "unknown", "failed"].includes(String(result))) {
          completeDetails = { ...details, delivery: { ...details.delivery!, status: result as "delivered" | "unknown" | "failed" } };
        }
        try { await ports.audit.complete(context, action, "ok", completeDetails); } catch { throw new Error("audit_unavailable"); }
        check();
        await acceptResult?.(result, auditRef);
        if (["logs.read", "code.search"].includes(action)) {
          check();
          running.modelTools.push(structuredClone({ tool: action, callId: context.callId, result }));
        }
        return result;
      };
      try { return await beforeDeadline(ports.clock, context.deadline, work, phaseController.signal); }
      catch (error) {
        if (attempt?.recoverable(error)) throw error;
        if (invoked && (phaseController.signal.aborted || ports.clock.now() >= context.deadline)) {
          void beforeDeadline(ports.clock, running.cleanupDeadline ?? ports.clock.now() + CLEANUP_MS, async () => {
            if (action === "model.generate") await ports.budget.settle(context, null, { execution: "unknown", source: "unknown" });
            await ports.audit.complete(context, action, "unknown");
          }).catch(() => {});
        }
        if (running.context.phaseId === phaseContext.phaseId && running.view.state === "investigating") {
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
      const targetRef = kind === "log" ? (read.value as SimulatorObservation | null)?.applicationRef : observation?.applicationRef;
      if (kind === "log" && targetRef && targetRef !== selectedApplicationRef) throw new Error("invalid_request");
      if (kind === "log" && selectedSubmittedOn && (read.value as SimulatorObservation | null)?.submittedOn !== selectedSubmittedOn) throw new Error("invalid_request");
      for (const [index, item] of read.evidence.entries()) {
        if (item.kind !== kind || item.sourceRef !== "simulator-source") throw new Error("schema_mismatch");
        if (targetRef && item.targetRef !== targetRef) throw new Error("invalid_request");
        if (kind === "code" && (item.code?.snapshotRef !== phaseContext.snapshotRef ||
          item.code.repositoryRef !== "simulator-source" || !["main", "master"].includes(item.code.branch) ||
          !/^[a-f0-9]{40}$/.test(item.code.commit) || !item.code.receiptRef)) throw new Error("version_mismatch");
        const evidence = { ...item, completeness: read.completeness, truncated: item.truncated || read.truncated,
          evidenceRef: `${phaseContext.caseRef}:phase-${phaseContext.phaseId}:${kind}:${++evidenceSequence}:${index}`, caseRef: phaseContext.caseRef,
          sanitizationVersion: "mock-sanitization-1", auditRef };
        await this.saveRecord(running, phaseContext, ports, { recordRef: evidence.evidenceRef, schemaVersion: 1, kind: "evidence", payload: evidence });
        assertCurrent();
        investigation.acceptEvidence(evidence);
      }
    };
    const invoke = async (tool: string, query: unknown): Promise<unknown> => {
      if (tool === "logs.read") {
        if (query !== null) throw new Error("invalid_request");
        if (running.view.usage.logRecords >= MAX_LOG_RECORDS) throw new Error("budget_exhausted");
        let rawCandidates: ApplicationCandidates["candidates"] | undefined;
        let logAuditRef = "";
        const read = await guarded("logs.read", async (context) => {
          const result = await ports.logs.read(context, {
            sourceRef: "simulator-source", ...(selectedApplicationId !== undefined
              ? { applicationId: selectedApplicationId } : { customerId: phaseInbound.input.customerId! }),
            from: this.scope!.queryWindow.from, to: this.scope!.queryWindow.to, pageSize: 100,
          });
          assertCurrent();
          if (ports.clock.now() >= context.deadline) throw new Error("timeout");
          if (!Array.isArray(result.evidence)) throw new Error("schema_mismatch");
          const windowKey = `${this.scope!.queryWindow.from}/${this.scope!.queryWindow.to}`;
          const newCoverage = running.coverageWindows.has(windowKey) ? 0
            : Date.parse(this.scope!.queryWindow.to) - Date.parse(this.scope!.queryWindow.from);
          running.coverageWindows.add(windowKey);
          running.view = { ...running.view, usage: { ...running.view.usage,
            logRecords: running.view.usage.logRecords + result.evidence.length,
            logCoverageMs: running.view.usage.logCoverageMs + newCoverage } };
          await this.saveView(running, ports);
          if (result.value && "kind" in result.value) rawCandidates = structuredClone(result.value.candidates);
          return result;
        }, (_read, auditRef) => { logAuditRef = auditRef; });
        if (read.value && "kind" in read.value && read.value.kind === "application_candidates") {
          if (read.completeness !== "complete" || read.truncated || !read.evidence.length) throw new Error("contract_unverified");
          if (selectedApplicationId !== undefined || read.value.customerRef !== safeInput.customerId ||
            read.value.candidates.length < 1 || read.value.candidates.length > 100 || !rawCandidates ||
            read.value.candidates.some((item) => !item.applicationId || !Number.isFinite(Date.parse(item.submittedAt)))) throw new Error("invalid_request");
          if (read.value.candidates.length === 1) {
            selectedApplicationId = rawCandidates[0]!.applicationId;
            selectedApplicationRef = read.value.candidates[0]!.applicationId;
            selectedSubmittedOn = read.value.candidates[0]!.submittedAt.slice(0, 10);
            investigation.selectTarget(selectedApplicationRef);
            return invoke("logs.read", null);
          }
          const informationContext = contextFor("requestInformation");
          try {
            await ports.audit.intent(informationContext, "requestInformation");
            await ports.audit.complete(informationContext, "requestInformation", "awaiting_input");
          } catch { throw new Error("audit_unavailable"); }
          assertCurrent();
          if (ports.clock.now() >= phaseContext.deadline) throw new Error("timeout");
          running.candidates = rawCandidates!;
          investigation.awaitInformation();
          running.cancelDeadline?.();
          phaseController.abort();
          const { deadlineAt: _deadline, ...withoutDeadline } = running.view;
          running.view = { ...withoutDeadline, state: "awaiting_input", waitingStartedAt: ports.clock.utc(), question: {
            questionId: `${phaseContext.caseRef}:question:${phaseContext.phaseId}`, requiredFields: ["submittedAt"],
            candidates: read.value.candidates.map((candidate, index) => ({ candidateRef: `candidate-${index + 1}`, submittedAt: candidate.submittedAt })),
            format: "ISO-8601 UTC", prompt: "Select the submission time for this customer's application; do not change the investigation target.",
          }, inputWaits: [...running.view.inputWaits, { questionId: `${phaseContext.caseRef}:question:${phaseContext.phaseId}`, startedAt: ports.clock.utc() }] };
          this.endPhase(running, "awaiting_input", ports);
          await ports.agent.abort(phaseContext.caseRef, phaseContext.phaseId);
          throw new Error("awaiting_input");
        }
        await acceptEvidence(read, "log", logAuditRef);
        observation = read.evidence.length ? read.value as SimulatorObservation | null : null;
        return read;
      }
      if (tool === "code.search") {
        if (query !== null) throw new Error("invalid_request");
        const read = await guarded("code.search", (context) => ports.code.search(context,
          { repositoryRef: "simulator-source", snapshotRef: context.snapshotRef }),
          (read, auditRef) => acceptEvidence(read, "code", auditRef));
        return read;
      }
      throw new Error("denied");
    };
    let draft: DiagnosticReport | undefined;
    let draftVersion = -1;
    const diagnose = (): DiagnosticReport => {
      if (!draft || draftVersion !== investigation.materialVersion) {
        draft = investigation.diagnose(observation, safeInput.question, ports.clock.utc());
        draftVersion = investigation.materialVersion;
      }
      return draft;
    };
    try {
      safeInput = ports.sanitization.sanitize(phaseInbound.input, phaseContext.caseRef);
      if (!ports.sanitization.safe(safeInput)) throw new Error("unsafe_content");
      selectedApplicationRef = safeInput.applicationId;
      if (selectedApplicationRef) investigation.selectTarget(selectedApplicationRef);
      const candidate = await guarded("agent.run", (context) => ports.agent.run(context, {
        question: safeInput.question, invoke, diagnose,
        progress: (value) => {
          assertCurrent();
          if (!boundedBody(value) || !ports.sanitization.safe(ports.sanitization.sanitize(value, phaseContext.caseRef))) throw new Error("unsafe_content");
          // Progress is deliberately not retained or forwarded and never changes any deadline.
        },
        generate: (inputDraft) => {
          const draft = structuredClone(inputDraft);
          return retryModel(ports.clock, phaseContext.deadline, () => contextFor("model.generate").callId, async (identity) => {
            let networkFailure: unknown;
            const response = await guarded("model.generate", async (modelContext) => {
              if (!ports.sanitization.safe(draft)) throw new Error("unsafe_content");
              if (running.view.usage.modelAttempts >= MAX_MODEL_ATTEMPTS) throw new Error("budget_exhausted");
              const envelope = modelEnvelope(safeInput.question, running.modelHistory, running.modelTools, draft, this.scope!.modelPolicy);
              running.view = { ...running.view, usage: { ...running.view.usage, modelAttempts: running.view.usage.modelAttempts + 1 } };
              await this.saveRecord(running, modelContext, ports, { recordRef: `${modelContext.callId}:input`, schemaVersion: 1, kind: "model_input", payload: envelope });
              await this.saveView(running, ports);
              if (!await ports.budget.reserve(modelContext, envelope.planning.reservationMicrousd, async () => {
                if (!await ports.authorization.allows("model.generate", modelContext)) {
                  await recordDenial(ports.audit, modelContext);
                  throw new Error("denied");
                }
                assertCurrent();
                if (ports.clock.now() >= modelContext.deadline) throw new Error("timeout");
              })) throw new Error("budget_exhausted");
              assertCurrent();
              if (ports.clock.now() >= modelContext.deadline) throw new Error("timeout");
              let response;
              try { response = await ports.model.generate(modelContext, draft, envelope); }
              catch (error) {
                if (error instanceof ModelFailure && error.kind === "transient_network") networkFailure = error;
                await ports.budget.settle(modelContext, null, { execution: "unknown", source: "unknown" });
                throw error;
              }
              const usageSource = response.usageSource ?? (response.actualMicrousd !== null && response.actualMicrousd > 0 ? "mock_usage" : "unknown");
              await ports.budget.settle(modelContext, response.actualMicrousd, { execution: "ended", source: usageSource });
              if (["mock_usage", "upstream_usage"].includes(usageSource) && response.actualMicrousd !== null &&
                response.actualMicrousd > envelope.planning.reservationMicrousd) throw new Error("contract_unverified");
              validateModelResponse(response);
              if (!ports.sanitization.safe(response)) throw new Error("unsafe_content");
              return response;
            }, (response) => { running.modelHistory.push(structuredClone({ role: "assistant", content: response.candidate })); },
              { ...identity, recoverable: (error) => identity.retryable && error === networkFailure });
            return response.candidate;
          });
        },
      }));
      if (!ports.sanitization.safe(candidate)) throw new Error("unsafe_content");
      const report = investigation.finish(candidate, diagnose());
      await this.saveRecord(running, phaseContext, ports, { recordRef: report.reportRef, schemaVersion: 1, kind: "report", payload: report });
      const deliveryStatus = await guarded("delivery.send", (context) => {
        running.view = { ...running.view, deliveryStatus: "unknown" };
        return ports.delivery.send(context.destinationRef, report, `${context.caseRef}:report:1`);
      });
      running.view = { ...running.view, state: "completed", reportRef: report.reportRef, deliveryStatus };
      this.endPhase(running, "completed", ports);
    } catch (error: unknown) {
      const reason = safeReason(error);
      if (running.context.phaseId === phaseContext.phaseId && running.view.state === "investigating") {
        running.view = { ...running.view, state: "stopped", stopReason: reason };
        this.endPhase(running, "stopped", ports);
        await this.stopPhase(running, phaseContext, reason, ports);
      }
    } finally {
      await this.closePhase(running, phaseContext, ports);
    }
  }
}
