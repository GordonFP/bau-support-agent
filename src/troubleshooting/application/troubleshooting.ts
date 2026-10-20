import { TroubleshootingCase } from "../domain/simulator.js";
import type { DiagnosticReport, SimulatorObservation } from "../domain/simulator.js";
import type { Acceptance, CallContext, CaseView, Ports, ReadResult, SafeReason, VerifiedInbound } from "./ports.js";

const reasons = new Set<SafeReason>(["denied", "invalid_request", "contract_unverified", "schema_mismatch", "unavailable",
  "timeout", "cancelled", "rate_limited", "budget_exhausted", "version_unknown", "version_mismatch", "unsafe_content", "audit_unavailable"]);
const requiredPorts = ["clock", "authorization", "sanitization", "audit", "budget", "logs", "code", "agent", "model", "delivery"] as const;

interface RunningCase {
  readonly inbound: VerifiedInbound;
  readonly controller: AbortController;
  readonly context: CallContext;
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
    if (requiredPorts.some((key) => !this.configured[key]) || this.scope?.mode !== "mock") return { status: "service_unavailable", reason: "unavailable" };
    const windowSize = Date.parse(this.scope.queryWindow.to) - Date.parse(this.scope.queryWindow.from);
    if (!this.scope.snapshotRef || !Number.isFinite(windowSize) || windowSize <= 0 || windowSize > 86_400_000) {
      return { status: "service_unavailable", reason: "invalid_request" };
    }
    const ports = this.configured as Ports;
    if (!inbound || inbound.conversationKind !== "private" || !inbound.eventRef || !inbound.tenantRef ||
        !inbound.principalRef || !inbound.destinationRef || typeof inbound.input?.applicationId !== "string" ||
        !inbound.input.applicationId || typeof inbound.input.question !== "string" || !Number.isFinite(Date.parse(inbound.receivedAt))) {
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
      acceptedAt: now, phaseStartedAt: now, deadlineAt: new Date(Date.parse(now) + 180_000).toISOString(), deliveryStatus: "pending" };
    const running = { inbound: structuredClone(inbound), context, controller, view };
    this.cases.set(caseRef, running);
    // The inbound caller receives acceptance independently of investigation completion.
    void this.investigate(running, ports);
    return { status: "accepted", view: structuredClone(view) };
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
      return structuredClone(running.view);
    } catch { return { status: "denied" }; }
  }

  private async investigate(running: RunningCase, ports: Ports): Promise<void> {
    const investigation = new TroubleshootingCase(running.context.caseRef);
    let observation: SimulatorObservation | null = null;
    let callSequence = 0;
    let safeInput: VerifiedInbound["input"];
    const contextFor = (action: string): CallContext => Object.freeze({ ...running.context, callId: `${running.context.caseRef}:${action}:${++callSequence}` });
    const guarded = async <T>(action: string, operation: (context: CallContext) => Promise<T>, acceptResult?: (result: T, auditRef: string) => void): Promise<T> => {
      if (ports.clock.now() >= running.context.deadline) throw new Error("timeout");
      if (running.controller.signal.aborted) throw new Error("cancelled");
      const context = contextFor(action);
      if (!await ports.authorization.allows(action, context)) throw new Error("denied");
      let auditRef: string;
      try { auditRef = await ports.audit.intent(context, action); } catch { throw new Error("audit_unavailable"); }
      const output = await operation(context);
      if (action === "agent.run" && !ports.sanitization.safe(output)) throw new Error("unsafe_content");
      const result = ports.sanitization.sanitize(output, context.caseRef);
      try { await ports.audit.complete(context, action, "ok"); } catch { throw new Error("audit_unavailable"); }
      if (ports.clock.now() >= context.deadline) throw new Error("timeout");
      acceptResult?.(result, auditRef);
      return result;
    };
    const acceptEvidence = (read: ReadResult<unknown>, kind: "log" | "code", auditRef: string) => {
      if (!read || !["complete", "partial", "unknown"].includes(read.completeness) || !Array.isArray(read.evidence)) throw new Error("schema_mismatch");
      const targetRef = kind === "log" ? (read.value as SimulatorObservation | null)?.applicationRef : observation?.applicationRef;
      if (kind === "log" && targetRef && targetRef !== safeInput.applicationId) throw new Error("invalid_request");
      read.evidence.forEach((item, index) => {
        if (item.kind !== kind || item.sourceRef !== "simulator-source") throw new Error("schema_mismatch");
        if (targetRef && item.targetRef !== targetRef) throw new Error("invalid_request");
        if (kind === "code" && (item.code?.snapshotRef !== running.context.snapshotRef ||
          item.code.repositoryRef !== "simulator-source" || !["main", "master"].includes(item.code.branch) ||
          !/^[a-f0-9]{40}$/.test(item.code.commit) || !item.code.receiptRef)) throw new Error("version_mismatch");
        investigation.acceptEvidence({ ...item, completeness: read.completeness, truncated: item.truncated || read.truncated,
          evidenceRef: `${running.context.caseRef}:${kind}:${index}`, caseRef: running.context.caseRef,
          sanitizationVersion: "mock-sanitization-1", auditRef });
      });
    };
    const invoke = async (tool: string, query: unknown): Promise<unknown> => {
      if (tool === "logs.read") {
        if (query !== null) throw new Error("invalid_request");
        const read = await guarded("logs.read", (context) => ports.logs.read(context, {
          sourceRef: "simulator-source", applicationId: running.inbound.input.applicationId,
          from: this.scope!.queryWindow.from, to: this.scope!.queryWindow.to, pageSize: 100,
        }), (read, auditRef) => acceptEvidence(read, "log", auditRef));
        observation = read.evidence.length ? read.value : null;
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
      safeInput = ports.sanitization.sanitize(running.inbound.input, running.context.caseRef);
      if (!ports.sanitization.safe(safeInput)) throw new Error("unsafe_content");
      const candidate = await guarded("agent.run", (context) => ports.agent.run(context, {
        question: safeInput.question, invoke, diagnose,
        generate: (draft) => guarded("model.generate", async (modelContext) => {
          if (!ports.sanitization.safe(draft)) throw new Error("unsafe_content");
          if (!await ports.budget.reserve(modelContext, 180_000)) throw new Error("budget_exhausted");
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
    } catch (error: unknown) {
      const reason = error instanceof Error && reasons.has(error.message as SafeReason) ? error.message as SafeReason : "unavailable";
      running.controller.abort();
      running.view = { ...running.view, state: "stopped", stopReason: reason };
    } finally {
      try { ports.sanitization.clear(running.context.caseRef); } catch { /* cleanup must not leak raw failures */ }
      // Original query values are kept only for the duration of this investigation.
      (running as { inbound: VerifiedInbound }).inbound = { ...running.inbound, input: { applicationId: "", question: "" } };
      try { await ports.agent.close(running.context.caseRef); } catch { /* safe state already retained */ }
    }
  }
}
