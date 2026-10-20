import { Troubleshooting } from "../../troubleshooting/application/troubleshooting.js";
import { MAX_ACTIVE_CASES } from "../../troubleshooting/application/limits.js";
import { randomUUID } from "node:crypto";
import { deniedContext, recordDenial } from "../../troubleshooting/application/authorization-audit.js";
import { advancesView, contextSnapshot, recordSnapshot, sameCaseAuthority, savedContextSnapshot } from "../../troubleshooting/application/record-contract.js";
import { auditRecord } from "../../troubleshooting/application/audit-record.js";
import { codeQuery } from "../../troubleshooting/application/code-query.js";
import type { OfflineScope } from "../../troubleshooting/application/troubleshooting.js";
import type { DiagnosticReport, SimulatorObservation } from "../../troubleshooting/domain/simulator.js";
import type { PspObservation } from "../../troubleshooting/domain/psp.js";
import type { ApplicationCandidates, CallContext, Ports, RuntimeRequest, SourceEvidence, TrustedActor, VerifiedInbound } from "../../troubleshooting/application/ports.js";
import type { InitialCase, CaseRecord, DeliveryRecord, RecordRole } from "../../troubleshooting/application/records.js";
import { RetentionLifecycle, type RetentionState } from "../../troubleshooting/application/retention-lifecycle.js";
import { recordAccessContext, recordActor, recordDisclosure, recordRole } from "../../troubleshooting/application/record-access.js";
import { MockModelBudget } from "./model-budget.js";
import { modelEnvelope, modelSystem, mockModelBody, mockModelPolicy, validateModelEnvelope } from "../../troubleshooting/application/model-envelope.js";
import type { ModelAssistant, ModelEnvelope, ModelMessage, ModelPolicy, ModelResponse, ModelTurn } from "../../troubleshooting/application/model-contract.js";

interface MockRuntimeRequest extends Omit<RuntimeRequest, "generate"> {
  readonly generate: (draft: DiagnosticReport | ModelTurn) => Promise<unknown>;
}

// All values and identities in this adapter are synthetic. No transport is created.
export const simulatorFixture: SimulatorObservation = {
  applicationRef: "SYNTHETIC-SECRET-APPLICATION", submittedOn: "2026-10-18",
  shops: Array.from({ length: 10 }, (_, index) => ({ shopRef: `shop-${index + 1}`, authorization: "active",
    completeThrough: index === 9 ? "2026-10-17" : "2026-10-18", coverageComplete: true })),
  calculation: { started: null, succeeded: null, estimate: null }, causes: [],
};

export interface MockOptions {
  readonly pspObservation?: PspObservation | null;
  readonly resourceRefs?: readonly string[];
  readonly modelPolicy?: ModelPolicy | null;
  readonly modelProfile?: "memory_mock" | "local_protocol";
  readonly lifecycleActors?: readonly TrustedActor[];
  readonly recordGrants?: readonly { readonly actor: TrustedActor; readonly role: RecordRole; readonly caseRefs: readonly string[]; readonly resourceRefs: readonly string[] }[];
  readonly controlPorts?: (ports: Ports) => Partial<Pick<Ports, "admission" | "records" | "audit" | "budget" | "retention">>;
  readonly authorizedActors?: readonly TrustedActor[];
  readonly observation?: SimulatorObservation | null;
  readonly completeness?: "complete" | "partial" | "unknown";
  readonly principalRef?: string;
  readonly denyActions?: readonly string[];
  readonly unavailableControls?: readonly (keyof Ports)[];
  readonly candidate?: (draft: DiagnosticReport) => unknown;
  readonly agent?: (context: CallContext, request: MockRuntimeRequest) => Promise<unknown>;
  readonly auditFails?: string;
  readonly evidenceTargetRef?: string;
  readonly clock?: Ports["clock"];
  readonly queryWindow?: OfflineScope["queryWindow"];
  readonly sanitizeFailsAt?: number;
  readonly customerCandidates?: ApplicationCandidates["candidates"];
  readonly model?: (context: CallContext, draft: DiagnosticReport, envelope?: ModelEnvelope) => Promise<Omit<ModelResponse, "message"> & { readonly message?: ModelAssistant }>;
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
  let modelBudget: MockModelBudget;
  const audits: Readonly<Record<string, unknown>>[] = [];
  const costFor = (callId: string) => modelBudget.cost(callId);
  const expiredEvents = new Map<string, string>();
  const admissions = new Map<string, { caseRef: string; principalRef: string; active: boolean }>();
  const cases = new Map<string, { initial: InitialCase; records: CaseRecord[]; deliveries: DeliveryRecord[] }>();
  const authorizedActors = structuredClone(options.authorizedActors ?? [
    { principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1" },
  ]);
  let sanitizationCount = 0;
  const scope: OfflineScope = { mode: "mock", snapshotRef: "simulator-snapshot-1", modelProfile: options.modelProfile ?? "memory_mock",
    ...(options.pspObservation !== undefined ? { resourceRefs: ["simulator-source", "psp-log-source", "psp-code"], psp: { sourceRef: "psp-log-source", repositoryRef: "psp-code" } } : {}),
    ...(options.resourceRefs ? { resourceRefs: Object.freeze([...options.resourceRefs]) } : {}),
    ...(options.modelPolicy === null ? {} : { modelPolicy: options.modelPolicy === undefined ? mockModelPolicy : Object.freeze(structuredClone(options.modelPolicy)) }),
    queryWindow: options.queryWindow ?? {
    from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z",
  } };
  const inbound: VerifiedInbound = { eventRef: "event-1", tenantRef: "tenant-1",
    principalRef: options.principalRef ?? "principal-1", destinationRef: "private-conversation-1", conversationKind: "private",
    receivedAt: "2026-10-19T09:00:00.000Z", input: { applicationId: "SYNTHETIC-SECRET-APPLICATION", question: "Why is SYNTHETIC-SECRET-APPLICATION still waiting?" } };
  const evidenceBase = { sourceRef: "simulator-source", acquiredAt: "2026-10-19T09:00:01.000Z", completeness: "complete" as const,
    truncated: false, targetRef: options.evidenceTargetRef ?? options.observation?.applicationRef ?? "SYNTHETIC-SECRET-APPLICATION" };
  const log: SourceEvidence = { ...evidenceBase, sourceRef: "simulator-source", kind: "log", locator: "synthetic-log:1", observedAt: "2026-10-18T23:00:00.000Z",
    text: "Synthetic submitted-shop coverage observation for SYNTHETIC-SECRET-APPLICATION.",
    log: { ...scope.queryWindow, queryRef: "synthetic-query-1" } };
  const code: SourceEvidence = { ...evidenceBase, sourceRef: "simulator-source", kind: "code", locator: "simulator.ts:10", observedAt: null,
    text: "Synthetic rule: all submitted shops require verified complete coverage through the submission date.",
    code: { repositoryRef: "simulator-source", branch: "main", commit: "1111111111111111111111111111111111111111",
      snapshotRef: "simulator-snapshot-1", indexedAt: "2026-10-19T08:00:00.000Z", receiptRef: "synthetic-snapshot-receipt-1" } };
  const codeFor = (repositoryRef: string): SourceEvidence => repositoryRef === "simulator-source" ? structuredClone(code)
    : { ...structuredClone(code), sourceRef: repositoryRef, locator: "psp.ts:10",
      text: "Synthetic PSP code alone does not prove this shop's executed verification path.", code: { ...code.code!, repositoryRef } };
  const authorizedRecord = async (actor: TrustedActor, caseRef: string, action: string, beforeDisclose?: () => Promise<void>) => {
    actor = recordActor(actor);
    if (ports.retention?.closed()) { ports.retention.recordDeniedAccess(actor, action); return null; }
    const saved = cases.get(caseRef);
    const owner = saved?.initial.context;
    const role = saved && owner ? await recordRole(ports.authorization, actor, owner, action) : null;
    if (!saved || !owner || !role) {
      await recordDenial(ports.audit, deniedContext(actor, caseRef, ports));
      return null;
    }
    const context = recordAccessContext(actor, owner, role, `${caseRef}:${action}:${randomUUID()}`, ports.clock.now());
    await ports.audit.intent(context, action);
    const result = structuredClone({ scope: "full" as const, view: saved.initial.view, records: saved.records,
      audits: audits.filter((entry) => entry.caseRef === caseRef), deliveries: saved.deliveries });
    await ports.audit.complete(context, action, "allowed");
    try { await beforeDisclose?.(); }
    catch { await recordDenial(ports.audit, context); return null; }
    const currentRole = await recordRole(ports.authorization, actor, owner, action);
    if (ports.retention?.closed()) { ports.retention.recordDeniedAccess(actor, action); return null; }
    if (currentRole !== role) {
      await recordDenial(ports.audit, deniedContext(actor, caseRef, ports));
      return null;
    }
    return recordDisclosure(result, role);
  };
  const readRecord = async (actor: TrustedActor, caseRef: string, action: string, beforeDisclose?: () => Promise<void>) => {
    try { return await authorizedRecord(actor, caseRef, action, beforeDisclose); } catch { throw new Error("unavailable"); }
  };
  const ports: Ports = {
    records: {
      async append(context, record) {
        context = contextSnapshot(context);
        record = recordSnapshot(context, record);
        if (ports.retention?.closed()) throw new Error("denied");
        const saved = cases.get(context.caseRef);
        if (!saved || !sameCaseAuthority(context, saved.initial.context) || !await ports.authorization.allows("records.append", context) || ports.retention?.closed()) {
          await recordDenial(ports.audit, deniedContext(context, context.caseRef, ports));
          throw new Error("denied");
        }
        if (!ports.sanitization.safe(record)) throw new Error("unavailable");
        const previous = saved.records.find((item) => item.recordRef === record.recordRef);
        if (previous) {
          if (JSON.stringify(previous) !== JSON.stringify(record)) throw new Error("unavailable");
          return;
        }
        saved.records.push(structuredClone(record));
        if (record.kind === "view" && advancesView(saved.initial.view, record.payload as InitialCase["view"])) saved.initial = { ...saved.initial, view: structuredClone(record.payload as InitialCase["view"]) };
      },
      async read(actor, caseRef, beforeDisclose) { return readRecord(actor, caseRef, "records.read", beforeDisclose); },
      async export(actor, caseRef) { return readRecord(actor, caseRef, "records.export"); },
    },
    admission: {
      async confirm(record) {
        if (ports.retention?.closed()) throw new Error("denied");
        events.push({ action: "admission.confirm", input: { key: record.key, caseRef: record.caseRef, principalRef: record.principalRef } });
        const existing = admissions.get(record.key);
        if (existing) return { status: "duplicate", caseRef: existing.caseRef, principalRef: existing.principalRef };
        if ([...admissions.values()].filter((item) => item.active).length >= MAX_ACTIVE_CASES) return { status: "full" };
        admissions.set(record.key, { caseRef: record.caseRef, principalRef: record.principalRef, active: true });
        const initial = savedContextSnapshot(record.initial.context);
        cases.set(record.caseRef, { initial: structuredClone({ ...record.initial, context: initial }),
          records: [{ recordRef: `${record.caseRef}:input`, schemaVersion: 1, kind: "input", payload: structuredClone(record.initial.input) }], deliveries: [] });
        return { status: "confirmed" };
      },
      async release(caseRef) { for (const item of admissions.values()) if (item.caseRef === caseRef) item.active = false; },
    },
    clock: options.clock ?? { now: () => 0, utc: () => "2026-10-19T09:00:00.000Z" },
    authorization: {
      async recordGrant(actor, owner) {
        const grant = options.recordGrants?.find((entry) => entry.actor.principalRef === actor.principalRef && entry.actor.tenantRef === actor.tenantRef &&
          entry.actor.destinationRef === actor.destinationRef && entry.caseRefs.includes(owner.caseRef));
        if (grant) return { role: grant.role, caseRef: owner.caseRef, resourceRefs: [...grant.resourceRefs] };
        return { role: "requester", caseRef: owner.caseRef, resourceRefs: owner.resourceRefs };
      },
      async allows(action, context) {
        if (action.startsWith("retention.")) return options.lifecycleActors?.some((actor) => actor.principalRef === context.principalRef &&
          actor.tenantRef === context.tenantRef && actor.destinationRef === context.destinationRef) === true && !options.denyActions?.includes(action);
        const trusted = authorizedActors.some((actor) => actor.tenantRef === context.tenantRef && actor.principalRef === context.principalRef && actor.destinationRef === context.destinationRef);
        const review = ["records.read", "records.export"].includes(action) && options.recordGrants?.some((grant) => grant.actor.principalRef === context.principalRef &&
          grant.actor.tenantRef === context.tenantRef && grant.actor.destinationRef === context.destinationRef && context.resourceRefs.every((ref) => grant.resourceRefs.includes(ref)));
        return (trusted || review === true) && context.resourceRefs.every((ref) => (scope.resourceRefs ?? ["simulator-source"]).includes(ref)) && !options.denyActions?.includes(action);
      },
    },
    sanitization: {
      sanitize<T>(value: T, caseRef: string): T {
        if (++sanitizationCount === options.sanitizeFailsAt) throw new Error("synthetic-sensitive-upstream-error");
        const json = JSON.stringify(value).replaceAll("SYNTHETIC-SECRET-APPLICATION", `[${caseRef}:application]`)
          .replaceAll("SYNTHETIC-SECRET-CUSTOMER", `[${caseRef}:customer]`).replaceAll("SYNTHETIC-SECRET-SHOP", `[${caseRef}:shop]`)
          .replaceAll("SYNTHETIC-SECRET-BINDING", `[${caseRef}:binding]`);
        return JSON.parse(json) as T;
      },
      safe: (value) => !/SYNTHETIC-SECRET|https?:\/\/|<script/i.test(JSON.stringify(value)),
      clear() {},
    },
    audit: {
      async intent(context, action, details) {
        if (ports.retention?.closed()) { ports.retention.recordDeniedAccess(context, action); throw new Error("denied"); }
        if (options.auditFails === `${action}:intent`) throw new Error("synthetic-audit-failure");
        events.push({ action: `audit:${action}:intent`, input: structuredClone({ ...context, signal: undefined, details }) });
        audits.push(structuredClone(auditRecord(context, action, "intent", "pending", ports.clock.utc(), details, costFor(context.callId))));
        if (["delivery.send", "delivery.notice"].includes(action) && details?.delivery) {
          cases.get(context.caseRef)?.deliveries.push({ schemaVersion: 1, caseRef: context.caseRef, callId: context.callId,
            deliveryKey: details.delivery.deliveryKey, segment: details.delivery.segment, status: "unknown" });
        }
        return `${context.callId}:intent`;
      },
      async complete(context, action, outcome, details) {
        if (ports.retention?.closed()) { ports.retention.recordDeniedAccess(context, action); throw new Error("denied"); }
        if (options.auditFails === `${action}:complete`) throw new Error("synthetic-audit-failure");
        events.push({ action: `audit:${action}:complete`, input: { callId: context.callId, outcome, details } });
        audits.push(structuredClone(auditRecord(context, action, "complete", outcome, ports.clock.utc(), details, costFor(context.callId))));
        if (["delivery.send", "delivery.notice"].includes(action) && outcome === "ok" && details?.delivery?.status) {
          const saved = cases.get(context.caseRef);
          if (saved) saved.deliveries = saved.deliveries.map((item) => item.callId === context.callId ? { ...item, status: details.delivery!.status!, ...(details.delivery!.receiptRef ? { receiptRef: details.delivery!.receiptRef } : {}) } : item);
        }
      },
    },
    budget: {
      reserve: (context, amount, beforeStart) => modelBudget.reserve(context, amount, beforeStart),
      settle: (context, amount, settlement) => modelBudget.settle(context, amount, settlement),
      status: (caseRef) => modelBudget.status(caseRef),
    },
    logs: { async read(context, query) {
      events.push({ action: "logs.read", input: query });
      if (query.customerId && options.customerCandidates) {
        return { value: { kind: "application_candidates", customerRef: query.customerId, candidates: options.customerCandidates },
          evidence: [{ ...structuredClone(log), targetRef: query.customerId }], completeness: options.completeness ?? "complete", truncated: false, warnings: [] };
      }
      const observation = query.sourceRef === "psp-log-source" ? options.pspObservation ?? null : options.observation === undefined ? simulatorFixture : options.observation;
      if (query.sourceRef === "psp-log-source" && options.pspObservation) {
        const value = options.pspObservation;
        const points = [{ eventRef: value.target.recordRef, observedAt: value.target.boundAt, target: value.target }, value.first, value.support,
          value.second.transaction, value.second.tailThree, value.final, ...value.linkedShops, ...(value.executions ?? [])];
        const seen = new Set<string>();
        const evidence = points.filter((point) => point.eventRef && point.observedAt && !seen.has(point.eventRef) && seen.add(point.eventRef)).map((point) =>
          ({ ...structuredClone(log), sourceRef: "psp-log-source", locator: point.eventRef!, observedAt: point.observedAt, text: `Synthetic PSP observation: ${JSON.stringify(point)}` }));
        return { value: structuredClone(value), evidence, completeness: options.completeness ?? "complete", truncated: false, warnings: [] };
      }
      return { value: structuredClone(observation), evidence: observation ? [structuredClone(log)] : [],
        completeness: options.completeness ?? "complete", truncated: false, warnings: [] };
    } },
    code: { async search(context, query) {
      codeQuery("search", query);
      events.push({ action: "code.search", input: query });
      return { value: null, evidence: [codeFor(query.repositoryRef)], completeness: "complete", truncated: false, warnings: [] };
    }, async snippet(context, query) {
      codeQuery("snippet", query);
      events.push({ action: "code.snippet", input: query });
      return { value: null, evidence: [codeFor(query.repositoryRef)], completeness: "complete", truncated: false, warnings: [] };
    }, async trace(context, query) {
      codeQuery("trace", query);
      events.push({ action: "code.trace", input: query });
      return { value: null, evidence: [codeFor(query.repositoryRef)], completeness: "complete", truncated: false, warnings: [] };
    } },
    agent: {
      async run(context, request) {
        let sequence = 0;
        const history: ModelMessage[] = [{ role: "system", content: modelSystem, toolsAdded: ["logs_read", "code_search"].map((name) => ({
          name: name as "logs_read" | "code_search", description: `Approved synthetic ${name}.`, parameters: { type: "object", properties: {}, additionalProperties: false } })) },
          { role: "user", content: request.question }];
        const compatible: MockRuntimeRequest = { ...request,
          invoke: async (tool, query) => {
            const result = await request.invoke(tool, query);
            if (tool === "logs.read" || tool === "code.search") {
              const name = tool === "logs.read" ? "logs_read" : "code_search";
              const id = `${context.caseRef}:phase-${context.phaseId}:mock-tool:${++sequence}`;
              history.push({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] },
                { role: "toolResult", toolCallId: id, toolName: name, content: JSON.stringify(result), isError: false });
            }
            return result;
          },
          generate: async (input) => {
            if ("messages" in input) return request.generate(input);
            const response = await request.generate({ schemaVersion: 1, messages: [...structuredClone(history), { role: "user", content: JSON.stringify({ draft: input }) }] });
            history.push({ role: "assistant", content: [{ type: "text", text: JSON.stringify(response.candidate) }] });
            return response.candidate;
          },
        };
        if (options.agent) return options.agent(context, compatible);
        await compatible.invoke("logs.read", null);
        await compatible.invoke("code.search", null);
        return compatible.generate(compatible.diagnose());
      },
      async abort(caseRef, phaseId) { events.push({ action: "agent.abort", input: { caseRef, phaseId } }); aborted.resolve(); },
      async close(caseRef, phaseId = 1) {
        events.push({ action: "agent.close", input: { caseRef, phaseId } });
        phaseClosure(phaseId, caseRef).resolve();
        closed.resolve();
      },
    },
    model: { async generate(context, turn, beforeSend) {
      const envelope = modelEnvelope(turn, mockModelBody(turn), mockModelPolicy);
      validateModelEnvelope(turn, envelope, mockModelPolicy);
      await beforeSend(envelope);
      const last = turn.messages.at(-1);
      if (last?.role !== "user") throw new Error("schema_mismatch");
      let draft: DiagnosticReport | undefined;
      try { draft = (JSON.parse(last.content) as { draft?: DiagnosticReport }).draft; } catch { /* A full neutral turn need not contain a report draft. */ }
      events.push({ action: "model.generate", input: structuredClone(draft) });
      if (options.model && !draft) throw new Error("schema_mismatch");
      const candidate = () => {
        if (!draft) return "Synthetic model response.";
        if (options.candidate) return options.candidate(draft);
        return draft.scene === "psp" ? { reportRef: draft.reportRef, draftVersion: draft.draftVersion } : structuredClone(draft);
      };
      const response = options.model ? await options.model(context, draft!, envelope) : { candidate: candidate(), actualMicrousd: 1_000 };
      return { ...response, message: "message" in response && response.message ? response.message : { stopReason: "stop",
        content: [{ type: "text", text: typeof response.candidate === "string" ? response.candidate : JSON.stringify(response.candidate) }] } };
    } },
    delivery: { async notice(destinationRef, notice, deliveryKey, attempt) {
      await attempt?.beforeWrite();
      events.push({ action: "delivery.notice", input: { destinationRef, notice, deliveryKey } });
      return "delivered";
    }, async fault(destinationRef, notice, deliveryKey, attempt) {
      await attempt?.beforeWrite(notice);
      events.push({ action: "delivery.fault", input: { destinationRef, notice, deliveryKey } });
      return "delivered";
    }, async send(destinationRef, report, deliveryKey, attempt) {
      await attempt?.beforeWrite();
      events.push({ action: "delivery.send", input: { destinationRef, report, deliveryKey } });
      sent.resolve({ destinationRef, report, deliveryKey });
      return "delivered";
    } },
  };
  let retentionState: RetentionState = { scope: "poc", state: "untriggered", triggers: [], events: [] };
  Object.assign(ports, { retention: new RetentionLifecycle(ports, { load: () => structuredClone(retentionState),
    save: (state) => { retentionState = structuredClone(state); },
    purge: async () => {
      for (const [key, value] of admissions) expiredEvents.set(key, value.caseRef);
      cases.clear(); admissions.clear(); audits.length = 0;
      return [{ scope: "mock_records", result: "deleted" as const, verification: "controlled record maps cleared; minimal event digests retained" }];
    } }) });
  modelBudget = new MockModelBudget(ports);
  ports.retention?.onClose(async () => modelBudget.close());
  Object.assign(ports, options.controlPorts?.(ports));
  const configured: Partial<Ports> = { ...ports };
  for (const key of options.unavailableControls ?? []) delete configured[key];
  const application = new Troubleshooting(configured, scope);
  return { application, ports, events, inbound, closed: closed.promise, aborted: aborted.promise,
    phaseClosed: (phaseId: number, caseRef = "case-1") => phaseClosure(phaseId, caseRef).promise,
    receive: (override: Partial<VerifiedInbound> = {}) => application.accept({ ...inbound, ...override }),
    delivery: { next: () => sent.promise } };
}
