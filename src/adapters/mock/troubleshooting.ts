import { Troubleshooting } from "../../troubleshooting/application/troubleshooting.js";
import { MAX_ACTIVE_CASES } from "../../troubleshooting/application/limits.js";
import type { OfflineScope } from "../../troubleshooting/application/troubleshooting.js";
import type { DiagnosticReport, SimulatorObservation } from "../../troubleshooting/domain/simulator.js";
import type { ApplicationCandidates, CallContext, Ports, RuntimeRequest, SourceEvidence, TrustedActor, VerifiedInbound } from "../../troubleshooting/application/ports.js";

// All values and identities in this adapter are synthetic. No transport is created.
export const simulatorFixture: SimulatorObservation = {
  applicationRef: "SYNTHETIC-SECRET-APPLICATION", submittedOn: "2026-10-18",
  shops: Array.from({ length: 10 }, (_, index) => ({ shopRef: `shop-${index + 1}`, authorization: "active",
    completeThrough: index === 9 ? "2026-10-17" : "2026-10-18", coverageComplete: true })),
  calculation: { started: null, succeeded: null, estimate: null }, causes: [],
};

export interface MockOptions {
  readonly authorizedActors?: readonly TrustedActor[];
  readonly observation?: SimulatorObservation | null;
  readonly completeness?: "complete" | "partial" | "unknown";
  readonly principalRef?: string;
  readonly denyActions?: readonly string[];
  readonly unavailableControls?: readonly (keyof Ports)[];
  readonly candidate?: (draft: DiagnosticReport) => unknown;
  readonly agent?: (context: CallContext, request: RuntimeRequest) => Promise<unknown>;
  readonly auditFails?: string;
  readonly evidenceTargetRef?: string;
  readonly clock?: Ports["clock"];
  readonly queryWindow?: OfflineScope["queryWindow"];
  readonly sanitizeFailsAt?: number;
  readonly customerCandidates?: ApplicationCandidates["candidates"];
  readonly model?: Ports["model"]["generate"];
}

export function createMockTroubleshooting(options: MockOptions = {}) {
  const sent = Promise.withResolvers<{ destinationRef: string; report: DiagnosticReport; deliveryKey: string }>();
  const closed = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const phaseClosures = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const phaseClosure = (phaseId: number, caseRef = "case-1") => {
    const key = `${caseRef}:${phaseId}`;
    if (!phaseClosures.has(key)) phaseClosures.set(key, Promise.withResolvers<void>());
    return phaseClosures.get(key)!;
  };
  const events: { action: string; input: unknown }[] = [];
  const reserved = new Map<string, number>();
  const admissions = new Map<string, { caseRef: string; principalRef: string; active: boolean }>();
  const authorizedActors = structuredClone(options.authorizedActors ?? [
    { principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1" },
  ]);
  let sanitizationCount = 0;
  const scope: OfflineScope = { mode: "mock", snapshotRef: "simulator-snapshot-1", queryWindow: options.queryWindow ?? {
    from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z",
  } };
  const inbound: VerifiedInbound = { eventRef: "event-1", tenantRef: "tenant-1",
    principalRef: options.principalRef ?? "principal-1", destinationRef: "private-conversation-1", conversationKind: "private",
    receivedAt: "2026-10-19T09:00:00.000Z", input: { applicationId: "SYNTHETIC-SECRET-APPLICATION", question: "Why is SYNTHETIC-SECRET-APPLICATION still waiting?" } };
  const evidenceBase = { sourceRef: "simulator-source", acquiredAt: "2026-10-19T09:00:01.000Z", completeness: "complete" as const,
    truncated: false, targetRef: options.evidenceTargetRef ?? options.observation?.applicationRef ?? "SYNTHETIC-SECRET-APPLICATION" };
  const log: SourceEvidence = { ...evidenceBase, kind: "log", locator: "synthetic-log:1", observedAt: "2026-10-18T23:00:00.000Z",
    text: "Synthetic submitted-shop coverage observation for SYNTHETIC-SECRET-APPLICATION.",
    log: { ...scope.queryWindow, queryRef: "synthetic-query-1" } };
  const code: SourceEvidence = { ...evidenceBase, kind: "code", locator: "simulator.ts:10", observedAt: null,
    text: "Synthetic rule: all submitted shops require verified complete coverage through the submission date.",
    code: { repositoryRef: "simulator-source", branch: "main", commit: "1111111111111111111111111111111111111111",
      snapshotRef: "simulator-snapshot-1", indexedAt: "2026-10-19T08:00:00.000Z", receiptRef: "synthetic-snapshot-receipt-1" } };
  const ports: Ports = {
    admission: {
      async confirm(record) {
        events.push({ action: "admission.confirm", input: record });
        const existing = admissions.get(record.key);
        if (existing) return { status: "duplicate", caseRef: existing.caseRef, principalRef: existing.principalRef };
        if ([...admissions.values()].filter((item) => item.active).length >= MAX_ACTIVE_CASES) return { status: "full" };
        admissions.set(record.key, { caseRef: record.caseRef, principalRef: record.principalRef, active: true });
        return { status: "confirmed" };
      },
      async release(caseRef) { for (const item of admissions.values()) if (item.caseRef === caseRef) item.active = false; },
    },
    clock: options.clock ?? { now: () => 0, utc: () => "2026-10-19T09:00:00.000Z" },
    authorization: { async allows(action, context) {
      return authorizedActors.some((actor) => actor.tenantRef === context.tenantRef && actor.principalRef === context.principalRef &&
        actor.destinationRef === context.destinationRef) && context.resourceRefs.every((ref) => ref === "simulator-source") &&
        !options.denyActions?.includes(action);
    } },
    sanitization: {
      sanitize<T>(value: T, caseRef: string): T {
        if (++sanitizationCount === options.sanitizeFailsAt) throw new Error("synthetic-sensitive-upstream-error");
        const json = JSON.stringify(value).replaceAll("SYNTHETIC-SECRET-APPLICATION", `[${caseRef}:application]`)
          .replaceAll("SYNTHETIC-SECRET-CUSTOMER", `[${caseRef}:customer]`);
        return JSON.parse(json) as T;
      },
      safe: (value) => !/SYNTHETIC-SECRET|https?:\/\/|<script/i.test(JSON.stringify(value)),
      clear() {},
    },
    audit: {
      async intent(context, action) {
        if (options.auditFails === `${action}:intent`) throw new Error("synthetic-audit-failure");
        events.push({ action: `audit:${action}:intent`, input: structuredClone({ ...context, signal: undefined }) });
        return `${context.callId}:intent`;
      },
      async complete(context, action, outcome) {
        if (options.auditFails === `${action}:complete`) throw new Error("synthetic-audit-failure");
        events.push({ action: `audit:${action}:complete`, input: { callId: context.callId, outcome } });
      },
    },
    budget: {
      async reserve(context, upperBoundMicrousd) { reserved.set(context.callId, upperBoundMicrousd); return true; },
      async settle(context, actualMicrousd) { if (actualMicrousd !== null) reserved.set(context.callId, actualMicrousd); },
      async status(caseRef) { return { reservedMicrousd: [...reserved.entries()]
        .filter(([callId]) => callId.startsWith(`${caseRef}:`)).reduce((sum, [, amount]) => sum + amount, 0) }; },
    },
    logs: { async read(context, query) {
      events.push({ action: "logs.read", input: query });
      if (query.customerId && options.customerCandidates) {
        return { value: { kind: "application_candidates", customerRef: query.customerId, candidates: options.customerCandidates },
          evidence: [{ ...structuredClone(log), targetRef: query.customerId }], completeness: options.completeness ?? "complete", truncated: false, warnings: [] };
      }
      const observation = options.observation === undefined ? simulatorFixture : options.observation;
      return { value: structuredClone(observation), evidence: observation ? [structuredClone(log)] : [],
        completeness: options.completeness ?? "complete", truncated: false, warnings: [] };
    } },
    code: { async search(context, query) {
      events.push({ action: "code.search", input: query });
      return { value: null, evidence: [structuredClone(code)], completeness: "complete", truncated: false, warnings: [] };
    } },
    agent: {
      run: options.agent ?? (async (_context, request) => {
        await request.invoke("logs.read", null);
        await request.invoke("code.search", null);
        return request.generate(request.diagnose());
      }),
      async abort(caseRef, phaseId) { events.push({ action: "agent.abort", input: { caseRef, phaseId } }); aborted.resolve(); },
      async close(caseRef, phaseId = 1) {
        events.push({ action: "agent.close", input: { caseRef, phaseId } });
        phaseClosure(phaseId, caseRef).resolve();
        closed.resolve();
      },
    },
    model: { async generate(context, draft) {
      events.push({ action: "model.generate", input: structuredClone(draft) });
      if (options.model) return options.model(context, draft);
      return { candidate: options.candidate ? options.candidate(draft) : structuredClone(draft), actualMicrousd: 1_000 };
    } },
    delivery: { async send(destinationRef, report, deliveryKey) {
      events.push({ action: "delivery.send", input: { destinationRef, report, deliveryKey } });
      sent.resolve({ destinationRef, report, deliveryKey });
      return "delivered";
    } },
  };
  const configured: Partial<Ports> = { ...ports };
  for (const key of options.unavailableControls ?? []) delete configured[key];
  const application = new Troubleshooting(configured, scope);
  return { application, ports, events, inbound, closed: closed.promise, aborted: aborted.promise,
    phaseClosed: (phaseId: number, caseRef = "case-1") => phaseClosure(phaseId, caseRef).promise,
    receive: (override: Partial<VerifiedInbound> = {}) => application.accept({ ...inbound, ...override }),
    delivery: { next: () => sent.promise } };
}
