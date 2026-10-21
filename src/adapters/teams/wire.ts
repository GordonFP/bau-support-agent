import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod/v4";
import type { App } from "@microsoft/teams.apps";
import type { Interceptor, Middleware } from "@microsoft/teams.common";
import type { JwtValidator } from "@microsoft/teams.apps/dist/middleware/index.js";
import type { DeliveryAttempt, DeliveryNotice, DeliveryResult } from "../../troubleshooting/application/communication.js";
import { MAX_MESSAGE_BYTES } from "../../troubleshooting/application/communication.js";
import { beforeDeadline } from "../../troubleshooting/application/deadline.js";
import { MAX_ACTIVE_CASES } from "../../troubleshooting/application/limits.js";
import type { Ports } from "../../troubleshooting/application/ports.js";
import type { TeamsConfiguration, TeamsMapping } from "./host.js";
import { teamsReceiptRef, userClaims } from "./identity.js";

interface Lease { readonly kind: "proof" | "write"; readonly mapping: TeamsMapping; signal: AbortSignal; readonly deadline: number;
  attempt?: DeliveryAttempt; wrote: boolean; }
const receiptSchema = z.strictObject({ id: z.string().min(1).max(256) });
interface Operation {
  binding: string; result: Promise<DeliveryResult> | DeliveryResult; settled: boolean;
  readonly completion?: { readonly confirmed: boolean }; caseRef: string; deliveryKey: string; segment: number; actor: TeamsMapping["actor"];
}
function settleOperation(entry: Operation, pending: Promise<DeliveryResult>) {
  // A settled native Promise retains its AsyncLocalStorage lease. Cache only the result value.
  void pending.then((value) => { entry.result = value; entry.settled = true; });
}

export function teamsWire(configuration: TeamsConfiguration, ports: Ports) {
  const local = new AsyncLocalStorage<Lease>();
  const stopping = new AbortController();
  const work = new Set<Promise<unknown>>();
  const operations = new Map<string, Operation>();
  // Audit-storage faults cannot be durably reconciled. Keep their unknown outcomes in an
  // independent bounded cache, refusing further fault writes when that cache is full.
  const faultOperations = new Map<string, Operation>();
  let overflowed = false;
  const questions = new Map<string, { caseRef: string; questionId: string; destinationRef: string }>();
  const cap = configuration.maxActivityBytes ?? MAX_MESSAGE_BYTES;
  if (!Number.isSafeInteger(cap) || cap < 2_048 || cap > MAX_MESSAGE_BYTES) throw new Error("contract_unverified");
  let app: App, validator: JwtValidator;
  const track = <T>(operation: Promise<T>): Promise<T> => {
    work.add(operation); void operation.then(() => work.delete(operation), () => work.delete(operation)); return operation;
  };
  const check = (lease: Lease) => {
    if (stopping.signal.aborted || lease.signal.aborted) throw new Error("cancelled");
    if (ports.clock.now() >= lease.deadline) throw new Error("timeout");
  };
  const prove = async (mapping: TeamsMapping, deadline: number, signal: AbortSignal, lookup?: () => Promise<string | undefined>): Promise<() => void> => {
    const controller = new AbortController();
    const lease: Lease = { kind: "proof", mapping, deadline, signal: AbortSignal.any([signal, controller.signal, stopping.signal]), wrote: false };
    const task = track(local.run(lease, async () => {
      try {
        check(lease);
        let proof: string | undefined;
        try { proof = lookup ? await lookup() : (await app.api.users.getToken({ userId: mapping.userId, channelId: "msteams", connectionName: configuration.user.connectionName })).token; }
        catch { throw new Error("denied"); }
        check(lease);
        const payload = proof ? await validator.validateAccessToken(proof) : null;
        check(lease); userClaims(payload, configuration, mapping);
        if (!await ports.authorization.allows("teams.identity", { ...mapping.actor, resourceRefs: [] })) throw new Error("denied");
        check(lease);
        const proofSignal = lease.signal;
        const current = () => { check({ ...lease, signal: proofSignal }); userClaims(payload, configuration, mapping);
          if (ports.authorization.current?.("teams.identity", { ...mapping.actor, resourceRefs: [] }) !== true) throw new Error("denied"); };
        current(); return current;
      } finally { lease.signal = stopping.signal; }
    }));
    return await beforeDeadline(ports.clock, deadline, () => task, lease.signal, () => controller.abort());
  };
  const middleware: Middleware = { async invoke(context, next) {
    const lease = local.getStore(); if (!lease) throw new Error("denied"); check(lease);
    const url = new URL(context.config.url ?? "", context.config.baseURL);
    const expected = lease.kind === "proof" ? new URL(`${configuration.tokenUrl}/api/usertoken/GetToken`)
      : new URL(`${configuration.serviceUrl}/v3/conversations/${encodeURIComponent(lease.mapping.conversationId)}/activities`);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash || url.username || url.password ||
      context.config.method !== (lease.kind === "proof" ? "get" : "post")) throw new Error("denied");
    if (lease.kind === "proof") {
      const params = [...url.searchParams.entries()].sort();
      const approved = [["channelId", "msteams"], ["connectionName", configuration.user.connectionName], ["userId", lease.mapping.userId]].sort();
      if (JSON.stringify(params) !== JSON.stringify(approved)) throw new Error("denied");
    } else if (url.search) throw new Error("denied");
    context.config.maxRedirects = 0; context.config.proxy = false;
    context.config.timeout = Math.max(1, Math.min(5_000, lease.deadline - ports.clock.now()));
    context.config.signal = lease.signal; context.config.maxContentLength = 4_096; context.config.maxBodyLength = cap;
    context.config.responseType = "json"; context.config.transitional = { silentJSONParsing: false, forcedJSONParsing: true };
    return next();
  } };
  const interceptor: Interceptor = {
    async request({ config }) {
      const lease = local.getStore(); if (!lease) throw new Error("denied"); check(lease);
      if (lease.kind === "write") {
        if (!lease.attempt || lease.wrote) throw new Error("denied");
        const data: unknown = config.data;
        const expected = { type: "message", text: lease.attempt.text, textFormat: "plain", from: { id: configuration.clientId, role: "bot" }, conversation: { id: lease.mapping.conversationId } };
        const serialized = JSON.stringify(data);
        if (serialized !== JSON.stringify(expected) || Buffer.byteLength(serialized) > cap || Buffer.byteLength(lease.attempt.text) > MAX_MESSAGE_BYTES) throw new Error("unsafe_content");
        const currentProof = await prove(lease.mapping, Math.min(lease.deadline, ports.clock.now() + 5_000), lease.signal);
        await lease.attempt.beforeWrite(lease.attempt.text);
        currentProof();
        if (!lease.attempt.current) throw new Error("contract_unverified");
        lease.attempt.current(); check(lease); lease.wrote = true;
        config.data = serialized;
        config.headers.set("Content-Type", "application/json");
        config.headers.set("Content-Length", String(Buffer.byteLength(serialized)));
        config.transformRequest = [(body: unknown) => body];
      }
      return config;
    },
    response({ res }) {
      const lease = local.getStore();
      if (lease?.kind === "write") {
        if (![200, 201].includes(res.status)) throw new Error("schema_mismatch");
        res.data = receiptSchema.parse(res.data as unknown);
      }
      return res;
    },
  };
  const send = (destinationRef: string, deliveryKey: string, attempt?: DeliveryAttempt, notice?: DeliveryNotice, fault = false): Promise<DeliveryResult> => {
    if (!attempt || stopping.signal.aborted || !deliveryKey.startsWith(`${attempt.caseRef}:`)) return Promise.resolve("failed");
    const mappings = configuration.mappings.filter((mapping) => mapping.actor.destinationRef === destinationRef);
    if (mappings.length !== 1) return Promise.resolve("failed");
    const mapping = mappings[0]!;
    const id = JSON.stringify([deliveryKey, attempt.segment]);
    const binding = fault || faultOperations.has(id) ? JSON.stringify([destinationRef, attempt.caseRef, attempt.phaseId, attempt.text]) : attempt.bindingRef;
    if (!binding || !fault && !faultOperations.has(id) && attempt.ticket && (attempt.ticket.caseRef !== attempt.caseRef || attempt.ticket.deliveryKey !== deliveryKey ||
      attempt.ticket.segment !== attempt.segment || attempt.ticket.bindingRef !== attempt.bindingRef)) return Promise.resolve("failed");
    const cache = fault ? faultOperations : operations;
    const previous = operations.get(id) ?? faultOperations.get(id);
    const recover = (result: DeliveryResult | Promise<DeliveryResult>): Promise<DeliveryResult> => track((async () => {
      try {
        const value = await result;
        await attempt.beforeWrite(attempt.text);
        if (stopping.signal.aborted || attempt.signal.aborted || ports.clock.now() >= attempt.deadline ||
          ports.authorization.current?.("teams.identity", { ...mapping.actor, resourceRefs: [] }) !== true) return "failed";
        if (!attempt.current) return "failed"; attempt.current(); return value;
      } catch { return "failed"; }
    })());
    if (previous) return previous.binding === binding && work.size < MAX_ACTIVE_CASES ? recover(previous.result) : Promise.resolve("failed");
    if (!fault && attempt.receipt && work.size >= MAX_ACTIVE_CASES) return Promise.resolve("failed");
    if (!fault && attempt.receipt) return recover(attempt.receipt.state === "complete" ? attempt.receipt.result : attempt.receipt.state === "pending" ? "unknown" : "failed");
    if (fault && faultOperations.size >= MAX_ACTIVE_CASES) return Promise.resolve("failed");
    if (work.size >= MAX_ACTIVE_CASES) return Promise.resolve("failed");
    const lease: Lease = { kind: "write", mapping, attempt, deadline: attempt.deadline, signal: AbortSignal.any([attempt.signal, stopping.signal]), wrote: false };
    const persisted = async (entry: { actor: TeamsMapping["actor"]; caseRef: string; deliveryKey: string; segment: number; binding: string }): Promise<{ known: boolean; result?: DeliveryResult }> => {
      const read = track(Promise.resolve().then(() => ports.deliveryLedger.read(entry.actor, { caseRef: entry.caseRef, deliveryKey: entry.deliveryKey, segment: entry.segment, bindingRef: entry.binding })));
      const saved = await beforeDeadline(ports.clock, Math.min(lease.deadline, ports.clock.now() + 5_000), () => read, lease.signal);
      check(lease);
      if (!saved) return { known: false };
      if (saved.state === "binding_mismatch") return { known: true, result: "failed" };
      if (saved.state === "complete") return { known: true, result: saved.result };
      return saved.state === "pending" ? { known: true, result: "unknown" } : { known: true };
    };
    const result: Promise<DeliveryResult> = track(local.run(lease, async (): Promise<DeliveryResult> => {
      try {
        // Install the in-flight deduplication entry synchronously before reconciliation awaits.
        await Promise.resolve(); check(lease);
        if (!fault && operations.size > 4_096) {
          overflowed = true;
          const candidates = [...operations.entries()].filter(([key, entry]) => key !== id && entry.settled);
          for (const [key, entry] of candidates) {
            if (operations.size <= 4_096) break;
            if (entry.completion?.confirmed === true) { if (operations.get(key) === entry) operations.delete(key); continue; }
            const durable = await persisted(entry);
            if (durable.known && durable.result !== undefined && operations.get(key) === entry) operations.delete(key);
          }
          if (operations.size > 4_096) { operations.delete(id); return "failed"; }
        }
        if (!fault && overflowed) {
          const prior = await persisted({ actor: mapping.actor, caseRef: attempt.caseRef, deliveryKey, segment: attempt.segment, binding });
          if (!prior.known) return "failed";
          if (prior.result !== undefined && !(prior.result === "unknown" && attempt.ticket && !attempt.ticket.completion.confirmed)) return prior.result;
          if (prior.result === undefined && !attempt.ticket) return "failed";
        }
        if (!fault && !attempt.ticket) {
          const prior = await persisted({ actor: mapping.actor, caseRef: attempt.caseRef, deliveryKey, segment: attempt.segment, binding });
          return prior.known ? prior.result ?? "failed" : "failed";
        }
        if (!fault && !attempt.ticket?.dispatch.claim()) {
          const prior = await persisted({ actor: mapping.actor, caseRef: attempt.caseRef, deliveryKey, segment: attempt.segment, binding });
          return prior.known ? recover(prior.result ?? "unknown") : "failed";
        }
        check(lease);
        const sent = await app.send(mapping.conversationId, { type: "message", text: attempt.text, textFormat: "plain" });
        const receipt = receiptSchema.parse({ id: sent.id });
        const receiptRef = teamsReceiptRef(mapping, receipt.id);
        if (notice?.kind === "question" && questions.has(receiptRef) && questions.get(receiptRef)!.questionId !== notice.question.questionId) return "unknown";
        if (notice?.kind === "question") questions.set(receiptRef, { caseRef: attempt.caseRef, questionId: notice.question.questionId, destinationRef });
        return { status: "delivered", receiptRef };
      } catch { if (!fault && !lease.wrote && operations.size > 4_096) operations.delete(id); return lease.wrote ? "unknown" : "failed"; }
      // Pooled HTTP resources may retain the ALS lease after the original send settles.
      finally { delete lease.attempt; lease.signal = stopping.signal; }
    }));
    const entry = { binding, result, settled: false, ...(attempt.ticket ? { completion: attempt.ticket.completion } : {}), caseRef: attempt.caseRef, deliveryKey, segment: attempt.segment, actor: mapping.actor };
    cache.set(id, entry);
    settleOperation(entry, result);
    return result;
  };
  const delivery: Ports["delivery"] = {
    // JSON-rendered application content has at most 2x JSON escaping overhead; final native body is checked again.
    maxTextBytes: Math.floor((cap - 1_024) / 2),
    send: (destination, _report, key, attempt) => send(destination, key, attempt),
    notice: (destination, notice, key, attempt) => send(destination, key, attempt, notice),
    fault: async (destination, _notice, key, attempt) => {
      const result = await send(destination, key, attempt, undefined, true); return typeof result === "string" ? result : result.status;
    },
  };
  return { middleware, interceptor, prove, delivery, questions,
    bind(nativeApp: App, nativeValidator: JwtValidator) { app = nativeApp; validator = nativeValidator; },
    async close() { stopping.abort(); while (work.size) await Promise.allSettled([...work]); operations.clear(); faultOperations.clear(); questions.clear(); },
  };
}
