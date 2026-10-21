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

interface Lease { readonly kind: "proof" | "write"; readonly mapping: TeamsMapping; readonly signal: AbortSignal; readonly deadline: number;
  readonly attempt?: DeliveryAttempt; wrote: boolean; }
const receiptSchema = z.strictObject({ id: z.string().min(1).max(256) });

export function teamsWire(configuration: TeamsConfiguration, ports: Ports) {
  const local = new AsyncLocalStorage<Lease>();
  const stopping = new AbortController();
  const work = new Set<Promise<unknown>>();
  const operations = new Map<string, { binding: string; result: Promise<DeliveryResult> }>();
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
      check(lease);
      let proof: string | undefined;
      try { proof = lookup ? await lookup() : (await app.api.users.getToken({ userId: mapping.userId, channelId: "msteams", connectionName: configuration.user.connectionName })).token; }
      catch { throw new Error("denied"); }
      check(lease);
      const payload = proof ? await validator.validateAccessToken(proof) : null;
      check(lease); userClaims(payload, configuration, mapping);
      if (!await ports.authorization.allows("teams.identity", { ...mapping.actor, resourceRefs: [] })) throw new Error("denied");
      check(lease);
      const current = () => { check(lease); userClaims(payload, configuration, mapping);
        if (!ports.authorization.current?.("teams.identity", { ...mapping.actor, resourceRefs: [] })) throw new Error("denied"); };
      current(); return current;
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
  const send = (destinationRef: string, deliveryKey: string, attempt?: DeliveryAttempt, notice?: DeliveryNotice): Promise<DeliveryResult> => {
    if (!attempt || stopping.signal.aborted || !deliveryKey.startsWith(`${attempt.caseRef}:`)) return Promise.resolve("failed");
    const mappings = configuration.mappings.filter((mapping) => mapping.actor.destinationRef === destinationRef);
    if (mappings.length !== 1 || work.size >= MAX_ACTIVE_CASES || operations.size >= 4_096) return Promise.resolve("failed");
    const mapping = mappings[0]!;
    const id = JSON.stringify([deliveryKey, attempt.segment]);
    const binding = JSON.stringify([destinationRef, attempt.caseRef, attempt.phaseId, attempt.text]);
    const previous = operations.get(id);
    if (previous) return previous.binding === binding ? previous.result : Promise.resolve("failed");
    const lease: Lease = { kind: "write", mapping, attempt, deadline: attempt.deadline, signal: AbortSignal.any([attempt.signal, stopping.signal]), wrote: false };
    const result: Promise<DeliveryResult> = track(local.run(lease, async (): Promise<DeliveryResult> => {
      try {
        check(lease);
        const sent = await app.send(mapping.conversationId, { type: "message", text: attempt.text, textFormat: "plain" });
        const receipt = receiptSchema.parse({ id: sent.id });
        const receiptRef = teamsReceiptRef(mapping, receipt.id);
        if (notice?.kind === "question" && questions.has(receiptRef) && questions.get(receiptRef)!.questionId !== notice.question.questionId) return "unknown";
        if (notice?.kind === "question") questions.set(receiptRef, { caseRef: attempt.caseRef, questionId: notice.question.questionId, destinationRef });
        return { status: "delivered", receiptRef };
      } catch { return lease.wrote ? "unknown" : "failed"; }
    }));
    operations.set(id, { binding, result }); return result;
  };
  const delivery: Ports["delivery"] = {
    // JSON-rendered application content has at most 2x JSON escaping overhead; final native body is checked again.
    maxTextBytes: Math.floor((cap - 1_024) / 2),
    send: (destination, _report, key, attempt) => send(destination, key, attempt),
    notice: (destination, notice, key, attempt) => send(destination, key, attempt, notice),
    fault: async (destination, _notice, key, attempt) => {
      const result = await send(destination, key, attempt); return typeof result === "string" ? result : result.status;
    },
  };
  return { middleware, interceptor, prove, delivery, questions,
    bind(nativeApp: App, nativeValidator: JwtValidator) { app = nativeApp; validator = nativeValidator; },
    async close() { stopping.abort(); while (work.size) await Promise.allSettled([...work]); operations.clear(); questions.clear(); },
  };
}
