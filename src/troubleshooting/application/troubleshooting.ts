import { TroubleshootingCase } from "../domain/simulator.js";
import type { DiagnosticReport, SimulatorObservation } from "../domain/simulator.js";
import type { Acceptance, ApplicationCandidates, CallContext, CaseView, InformationReply, InformationResult, Ports, ReadResult, SafeReason, VerifiedInbound } from "./ports.js";

const reasons = new Set<SafeReason>(["denied", "invalid_request", "contract_unverified", "schema_mismatch", "unavailable",
  "timeout", "cancelled", "rate_limited", "budget_exhausted", "version_unknown", "version_mismatch", "unsafe_content", "audit_unavailable"]);
const requiredPorts = ["clock", "authorization", "sanitization", "audit", "budget", "logs", "code", "agent", "model", "delivery"] as const;

interface RunningCase {
  inbound: VerifiedInbound;
  controller: AbortController;
  context: CallContext;
  readonly investigation: TroubleshootingCase;
  replyTail: Promise<void>;
  readonly replyEvents: Set<string>;
  readonly coverageWindows: Set<string>;
  readonly acceptedMono: number;
  finishedMono?: number;
  cancelDeadline?: () => void;
  candidates?: ApplicationCandidates["candidates"];
  targetSubmittedOn?: string;
  view: CaseView;
}

export interface OfflineScope {
  readonly mode: "mock";
  readonly snapshotRef: string;
  readonly queryWindow: { readonly from: string; readonly to: string };
}

export class Troubleshooting {
  private readonly cases = new Map<string, RunningCase>();
  private sequence = 0;

  constructor(private readonly configured: Partial<Ports>, private readonly scope?: OfflineScope) {}

  async accept(inbound: VerifiedInbound): Promise<Acceptance> {
    try { inbound = structuredClone(inbound); } catch { return { status: "denied", reason: "invalid_request" }; }
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
    const caseRef = `case-${++this.sequence}`;
    const controller = new AbortController();
    const now = ports.clock.utc();
    const context: CallContext = Object.freeze({ caseRef, phaseId: 1, callId: `${caseRef}:accept`, principalRef: inbound.principalRef,
      tenantRef: inbound.tenantRef, destinationRef: inbound.destinationRef, policyVersion: "mock-policy-1", approvalRef: "mock-approval-1",
      resourceRefs: Object.freeze(["simulator-source"]), snapshotRef: this.scope.snapshotRef, budgetRef: caseRef,
      deadline: ports.clock.now() + 180_000, signal: controller.signal });
    try {
      if (!await ports.authorization.allows("accept", context)) return { status: "denied", reason: "denied" };
      if (!ports.sanitization.safe(ports.sanitization.sanitize(inbound.input, caseRef))) {
        ports.sanitization.clear(caseRef);
        return { status: "denied", reason: "unsafe_content" };
      }
      await ports.audit.intent(context, "accept");
      await ports.audit.complete(context, "accept", "accepted");
    } catch {
      ports.sanitization.clear(caseRef);
      return { status: "service_unavailable", reason: "audit_unavailable" };
    }
    const view: CaseView = { caseRef, phaseId: 1, state: "investigating", receivedAt: inbound.receivedAt,
      acceptedAt: now, phaseStartedAt: now, deadlineAt: new Date(Date.parse(now) + 180_000).toISOString(), deliveryStatus: "pending",
      usage: { modelAttempts: 0, logRecords: 0, logCoverageMs: 0 }, elapsedMs: 0,
      phases: [{ phaseId: 1, startedAt: now }], inputWaits: [] };
    const investigation = new TroubleshootingCase(caseRef);
    const running: RunningCase = { inbound: structuredClone(inbound), context, controller, view, investigation,
      replyTail: Promise.resolve(), replyEvents: new Set(), coverageWindows: new Set(), acceptedMono: context.deadline - 180_000 };
    this.cases.set(caseRef, running);
    this.armDeadline(running, ports);
    // The inbound caller receives acceptance independently of investigation completion.
    void this.investigate(running, ports);
    return { status: "accepted", view: structuredClone(view) };
  }

  async provideInformation(reply: InformationReply): Promise<InformationResult> {
    try { reply = structuredClone(reply); } catch { return { status: "denied", reason: "invalid_request" }; }
    const running = this.cases.get(reply?.reply?.caseRef);
    if (!running || reply.principalRef !== running.context.principalRef || reply.tenantRef !== running.context.tenantRef ||
      reply.destinationRef !== running.context.destinationRef) return { status: "denied", reason: "denied" };
    const operation = running.replyTail.then(() => this.resumeFromInformation(running, reply, this.configured as Ports));
    running.replyTail = operation.then(() => {}, () => {});
    return operation;
  }

  private async resumeFromInformation(running: RunningCase, reply: InformationReply, ports: Ports): Promise<InformationResult> {
    try {
      if (!await ports.authorization.allows("provideInformation", running.context)) return { status: "denied", reason: "denied" };
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
      if (running.view.usage.modelAttempts >= 6 || running.view.usage.logRecords >= 500 || budget.reservedMicrousd >= 2_000_000) {
        running.view = { ...running.view, state: "stopped", stopReason: "budget_exhausted",
          inputWaits: running.view.inputWaits.map((wait) => wait.questionId === reply.reply.questionId
            ? { ...wait, endedAt: ports.clock.utc(), replyEventRef: reply.eventRef, replyReceivedAt: reply.receivedAt } : wait) };
        this.endPhase(running, "stopped", ports);
        ports.sanitization.clear(context.caseRef);
        running.inbound = { ...running.inbound, input: { question: "" } };
        delete running.candidates;
        return { status: "terminal", view: this.viewOf(running, ports), newCaseRequired: true };
      }
      await ports.audit.intent(context, "provideInformation");
      await ports.audit.complete(context, "provideInformation", "resumed");
      running.investigation.selectTarget(ports.sanitization.sanitize(candidate.applicationId, context.caseRef));
      const phaseId = running.investigation.resume();
      const controller = new AbortController();
      const startedAt = ports.clock.utc();
      running.context = Object.freeze({ ...running.context, phaseId, callId: `${context.caseRef}:phase-${phaseId}:start`,
        deadline: ports.clock.now() + 180_000, signal: controller.signal });
      running.controller = controller;
      running.inbound = { ...running.inbound, input: { applicationId: candidate.applicationId, question: running.inbound.input.question } };
      running.targetSubmittedOn = candidate.submittedAt.slice(0, 10);
      const { question: _question, waitingStartedAt: _waiting, ...view } = running.view;
      running.view = { ...view, phaseId, state: "investigating", phaseStartedAt: startedAt,
        deadlineAt: new Date(Date.parse(startedAt) + 180_000).toISOString(),
        phases: [...view.phases, { phaseId, startedAt }],
        inputWaits: view.inputWaits.map((wait) => wait.questionId === reply.reply.questionId
          ? { ...wait, endedAt: startedAt, replyEventRef: reply.eventRef, replyReceivedAt: reply.receivedAt } : wait) };
      running.replyEvents.add(reply.eventRef);
      this.armDeadline(running, ports);
      void this.investigate(running, ports);
      return { status: "resumed", view: this.viewOf(running, ports) };
    } catch { return { status: "denied", reason: "unavailable" }; }
  }

  private viewOf(running: RunningCase, ports: Ports): CaseView {
    const initialDelay = Math.max(0, Date.parse(running.view.acceptedAt) - Date.parse(running.view.receivedAt));
    return structuredClone({ ...running.view, elapsedMs: initialDelay + (running.finishedMono ?? ports.clock.now()) - running.acceptedMono });
  }

  private endPhase(running: RunningCase, outcome: "awaiting_input" | "completed" | "stopped", ports: Ports): void {
    running.view = { ...running.view, phases: running.view.phases.map((phase) => phase.phaseId === running.context.phaseId && !phase.endedAt
      ? { ...phase, endedAt: ports.clock.utc(), outcome } : phase) };
    if (outcome !== "awaiting_input") {
      running.investigation.stop();
      running.finishedMono ??= ports.clock.now();
    }
  }

  private armDeadline(running: RunningCase, ports: Ports): void {
    running.cancelDeadline?.();
    const context = running.context;
    const controller = running.controller;
    const expire = () => {
      if (running.context.phaseId !== context.phaseId || running.view.state !== "investigating" ||
        controller.signal.aborted || ports.clock.now() < context.deadline) return;
      controller.abort();
      running.view = { ...running.view, state: "stopped", stopReason: "timeout" };
      this.endPhase(running, "stopped", ports);
      void (async () => {
        try {
          const operation = { ...context, callId: `${context.caseRef}:phase-${context.phaseId}:timeout` };
          await ports.audit.intent(operation, "timeout");
          await ports.agent.abort(context.caseRef, context.phaseId);
          await ports.audit.complete(operation, "timeout", "stopped");
        } catch { /* no investigation or disclosure follows a deadline */ }
      })();
    };
    if (ports.clock.schedule) running.cancelDeadline = ports.clock.schedule(context.deadline, expire);
    else {
      const timer = setTimeout(expire, Math.max(0, context.deadline - ports.clock.now()));
      timer.unref();
      running.cancelDeadline = () => clearTimeout(timer);
    }
  }

  async get(principalRef: string, caseRef: string): Promise<CaseView | { readonly status: "denied" }> {
    const running = this.cases.get(caseRef);
    const ports = this.configured as Ports;
    if (!running || running.context.principalRef !== principalRef) return { status: "denied" };
    try {
      if (!await ports.authorization.allows("get", running.context)) return { status: "denied" };
      const context = { ...running.context, callId: `${caseRef}:get` };
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
    let safeInput: VerifiedInbound["input"];
    let selectedApplicationId = phaseInbound.input.applicationId;
    let selectedApplicationRef: string | undefined;
    let selectedSubmittedOn = running.targetSubmittedOn;
    const assertCurrent = (allowEnded = false) => {
      if ((!allowEnded && !investigation.isCurrentPhase(phaseContext.phaseId)) || phaseController.signal.aborted || running.context.phaseId !== phaseContext.phaseId) throw new Error("cancelled");
    };
    const contextFor = (action: string): CallContext => Object.freeze({ ...phaseContext, callId: `${phaseContext.caseRef}:phase-${phaseContext.phaseId}:${action}:${++callSequence}` });
    const guarded = async <T>(action: string, operation: (context: CallContext) => Promise<T>, acceptResult?: (result: T, auditRef: string) => void): Promise<T> => {
      const assertAllowed = () => assertCurrent(action === "delivery.send");
      if (ports.clock.now() >= phaseContext.deadline) throw new Error("timeout");
      assertAllowed();
      const context = contextFor(action);
      if (!await ports.authorization.allows(action, context)) throw new Error("denied");
      assertAllowed();
      let auditRef: string;
      try { auditRef = await ports.audit.intent(context, action); } catch { throw new Error("audit_unavailable"); }
      assertAllowed();
      const output = await operation(context);
      if (action === "agent.run" && !ports.sanitization.safe(output)) throw new Error("unsafe_content");
      const result = ports.sanitization.sanitize(output, context.caseRef);
      const discarded = phaseController.signal.aborted || running.context.phaseId !== phaseContext.phaseId;
      try { await ports.audit.complete(context, action, discarded ? "discarded" : "ok"); } catch { throw new Error("audit_unavailable"); }
      assertAllowed();
      if (ports.clock.now() >= context.deadline) throw new Error("timeout");
      acceptResult?.(result, auditRef);
      return result;
    };
    const acceptEvidence = (read: ReadResult<unknown>, kind: "log" | "code", auditRef: string) => {
      if (!read || !["complete", "partial", "unknown"].includes(read.completeness) || !Array.isArray(read.evidence)) throw new Error("schema_mismatch");
      const targetRef = kind === "log" ? (read.value as SimulatorObservation | null)?.applicationRef : observation?.applicationRef;
      if (kind === "log" && targetRef && targetRef !== selectedApplicationRef) throw new Error("invalid_request");
      if (kind === "log" && selectedSubmittedOn && (read.value as SimulatorObservation | null)?.submittedOn !== selectedSubmittedOn) throw new Error("invalid_request");
      read.evidence.forEach((item, index) => {
        if (item.kind !== kind || item.sourceRef !== "simulator-source") throw new Error("schema_mismatch");
        if (targetRef && item.targetRef !== targetRef) throw new Error("invalid_request");
        if (kind === "code" && (item.code?.snapshotRef !== phaseContext.snapshotRef ||
          item.code.repositoryRef !== "simulator-source" || !["main", "master"].includes(item.code.branch) ||
          !/^[a-f0-9]{40}$/.test(item.code.commit) || !item.code.receiptRef)) throw new Error("version_mismatch");
        investigation.acceptEvidence({ ...item, completeness: read.completeness, truncated: item.truncated || read.truncated,
          evidenceRef: `${phaseContext.caseRef}:${kind}:${index}`, caseRef: phaseContext.caseRef,
          sanitizationVersion: "mock-sanitization-1", auditRef });
      });
    };
    const invoke = async (tool: string, query: unknown): Promise<unknown> => {
      if (tool === "logs.read") {
        if (query !== null) throw new Error("invalid_request");
        if (running.view.usage.logRecords >= 500) throw new Error("budget_exhausted");
        let rawCandidates: ApplicationCandidates["candidates"] | undefined;
        let logAuditRef = "";
        const read = await guarded("logs.read", async (context) => {
          const result = await ports.logs.read(context, {
            sourceRef: "simulator-source", ...(selectedApplicationId !== undefined
              ? { applicationId: selectedApplicationId } : { customerId: phaseInbound.input.customerId! }),
            from: this.scope!.queryWindow.from, to: this.scope!.queryWindow.to, pageSize: 100,
          });
          if (!Array.isArray(result.evidence)) throw new Error("schema_mismatch");
          const windowKey = `${this.scope!.queryWindow.from}/${this.scope!.queryWindow.to}`;
          const newCoverage = running.coverageWindows.has(windowKey) ? 0
            : Date.parse(this.scope!.queryWindow.to) - Date.parse(this.scope!.queryWindow.from);
          running.coverageWindows.add(windowKey);
          running.view = { ...running.view, usage: { ...running.view.usage,
            logRecords: running.view.usage.logRecords + result.evidence.length,
            logCoverageMs: running.view.usage.logCoverageMs + newCoverage } };
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
        acceptEvidence(read, "log", logAuditRef);
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
    const diagnose = (): DiagnosticReport => draft ??= investigation.diagnose(observation, safeInput.question, ports.clock.utc());
    try {
      safeInput = ports.sanitization.sanitize(phaseInbound.input, phaseContext.caseRef);
      if (!ports.sanitization.safe(safeInput)) throw new Error("unsafe_content");
      selectedApplicationRef = safeInput.applicationId;
      if (selectedApplicationRef) investigation.selectTarget(selectedApplicationRef);
      const candidate = await guarded("agent.run", (context) => ports.agent.run(context, {
        question: safeInput.question, invoke, diagnose,
        generate: (draft) => guarded("model.generate", async (modelContext) => {
          if (!ports.sanitization.safe(draft)) throw new Error("unsafe_content");
          if (running.view.usage.modelAttempts >= 6) throw new Error("budget_exhausted");
          if (!await ports.budget.reserve(modelContext, 180_000)) throw new Error("budget_exhausted");
          assertCurrent();
          running.view = { ...running.view, usage: { ...running.view.usage, modelAttempts: running.view.usage.modelAttempts + 1 } };
          const response = await ports.model.generate(modelContext, draft);
          await ports.budget.settle(modelContext, response.actualMicrousd);
          if (!ports.sanitization.safe(response.candidate)) throw new Error("unsafe_content");
          return response.candidate;
        }),
      }));
      if (!ports.sanitization.safe(candidate)) throw new Error("unsafe_content");
      const report = investigation.finish(candidate, diagnose());
      const deliveryStatus = await guarded("delivery.send", (context) => ports.delivery.send(context.destinationRef, report, `${context.caseRef}:report:1`));
      running.view = { ...running.view, state: "completed", reportRef: report.reportRef, deliveryStatus };
      this.endPhase(running, "completed", ports);
    } catch (error: unknown) {
      const reason = error instanceof Error && reasons.has(error.message as SafeReason) ? error.message as SafeReason : "unavailable";
      if (running.context.phaseId === phaseContext.phaseId && running.view.state === "investigating") {
        phaseController.abort();
        running.view = { ...running.view, state: "stopped", stopReason: reason };
        this.endPhase(running, "stopped", ports);
      }
    } finally {
      if (running.context.phaseId === phaseContext.phaseId && running.view.state !== "awaiting_input") {
        running.cancelDeadline?.();
        try { ports.sanitization.clear(phaseContext.caseRef); } catch { /* cleanup must not leak raw failures */ }
        // Original query values are kept only while this case may still resume.
        (running as { inbound: VerifiedInbound }).inbound = { ...running.inbound, input: { applicationId: "", question: "" } };
        delete running.candidates;
      }
      try { await ports.agent.close(phaseContext.caseRef, phaseContext.phaseId); } catch { /* safe state already retained */ }
    }
  }
}
