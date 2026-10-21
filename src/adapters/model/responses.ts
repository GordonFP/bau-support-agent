import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext, Type, type Message, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import type { CallContext, Ports } from "../../troubleshooting/application/ports.js";
import type { BeforeModelSend, ModelContent, ModelEnvelope, ModelPolicy, ModelResponse, ModelTurn } from "../../troubleshooting/application/model-contract.js";
import { modelEnvelope, responsesModelPolicy, validateModelTurn } from "../../troubleshooting/application/model-envelope.js";
import { ModelFailure } from "../../troubleshooting/application/model-failure.js";
import { transportFailure } from "./transport-failure.js";
import { boundedResponse } from "./bounded-response.js";
import { terminalUsage } from "./terminal-usage.js";

export { responsesModelPolicy };
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function transcript(turn: ModelTurn): TranscriptContext {
  const messages: Message[] = turn.messages.map((item) => {
    if (item.role === "system") return { role: "system", content: item.content, timestamp: 0,
      ...(item.sections ? { sections: { ...item.sections } } : {}),
      ...(item.toolsAdded ? { toolsAdded: item.toolsAdded.map((tool) => ({ name: tool.name, description: tool.description, parameters: Type.Object({}, { additionalProperties: false }) })) } : {}),
      ...(item.toolsRemoved ? { toolsRemoved: item.toolsRemoved.map((name) => ({ name })) } : {}) };
    if (item.role === "user") return { ...item, timestamp: 0 };
    if (item.role === "toolResult") return { ...item, content: [{ type: "text", text: item.content }], timestamp: 0 };
    return { role: "assistant", content: structuredClone([...item.content]), timestamp: 0, api: "openai-responses", provider: "bau-synthetic",
      model: "gpt6.1-sol", usage: structuredClone(zeroUsage), stopReason: item.content.some((part) => part.type === "toolCall") ? "toolUse" : "stop" };
  });
  return normalizeContext({ messages });
}

export function createResponsesGateway(options: { readonly route: "mock" | "local_protocol" | "cpa" | "company"; readonly baseUrl: string; readonly contract: string;
  readonly clock?: Pick<Ports["clock"], "now"> }) {
  const base = new URL(options.baseUrl);
  if (options.route !== "local_protocol" || options.contract !== responsesModelPolicy.protocol || base.protocol !== "http:" || base.hostname !== "127.0.0.1" ||
    !base.port || base.username || base.password || base.search || base.hash || !base.pathname.endsWith("/v1")) throw new Error("contract_unverified");
  const model: Model<"openai-responses"> = { id: "gpt6.1-sol", name: "Synthetic alias only", api: "openai-responses", provider: "bau-synthetic",
    baseUrl: base.href, input: ["text"], reasoning: false, contextWindow: 24_000, maxTokens: 4_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsMaxOutputTokens: true, supportsStrictMode: true,
      supportsMidConvoSystemMessages: true, supportsAdditionalTools: false, supportsToolSearch: false } };
  return { async generate(context: CallContext, input: ModelTurn, beforeSend: BeforeModelSend): Promise<ModelResponse> {
    if (process.env.OPENAI_LOG && process.env.OPENAI_LOG !== "off") throw new Error("contract_unverified");
    const turn = structuredClone(input);
    validateModelTurn(turn);
    let failure: unknown;
    let sends = 0;
    let responseFinished = Promise.resolve();
    let terminal: "completed" | "incomplete" | "failed" | undefined;
    let usage: { actualMicrousd: number | null; source: "unknown" | "mock_usage" | "upstream_usage" | "estimated" } = { actualMicrousd: null, source: "unknown" };
    const ownedFetch: typeof fetch = async (url, init) => {
      let dispatched = false;
      try {
        if (++sends !== 1 || String(url) !== `${base.href}/responses` || init?.method !== "POST" || typeof init.body !== "string" || typeof beforeSend !== "function") throw new Error("contract_unverified");
        const canonicalInput = init.body;
        const prepared = modelEnvelope(turn, canonicalInput, responsesModelPolicy);
        await beforeSend(prepared);
        if (context.signal.aborted || init.signal?.aborted) throw new Error("cancelled");
        if (options.clock && options.clock.now() >= context.deadline) throw new Error("timeout");
        dispatched = true;
        const response = await fetch(url, { ...init, body: canonicalInput, redirect: "error" });
        const bounded = boundedResponse(response, (error) => { failure ??= error; }, context.signal);
        responseFinished = bounded.finished;
        return bounded.response;
      } catch (error) { failure = transportFailure(error, dispatched, context.signal); throw failure; }
    };
    const native = await streamSimple(model, transcript(turn), { apiKey: "synthetic-no-credential", maxTokens: 4_000, maxRetries: 0,
      cacheRetention: "none", fetch: ownedFetch, signal: context.signal, onProviderStreamEvent: (event) => {
        try { const found = terminalUsage(event); if (found) { terminal = found.status; usage = found; } }
        catch (error) { if (error instanceof ModelFailure && error.execution === "unknown") terminal = undefined; failure = error; throw error; }
      } }).result();
    await responseFinished.catch(() => {});
    const charge = usage.actualMicrousd === null ? undefined : { actualMicrousd: usage.actualMicrousd, source: usage.source };
    if (options.clock && options.clock.now() >= context.deadline) throw new ModelFailure("timeout", terminal ? "ended" : "unknown", charge);
    if (context.signal.aborted) throw new ModelFailure("cancelled", terminal ? "ended" : "unknown", charge);
    if (failure) {
      // The native codec may abort its reader after a valid non-success terminal event.
      if (terminal && !(failure instanceof ModelFailure)) throw new ModelFailure("schema_mismatch", "ended", charge);
      if (failure instanceof ModelFailure && terminal) throw new ModelFailure(failure.kind, "ended", charge ?? failure.charge);
      throw failure;
    }
    if (terminal !== "completed" || !["stop", "toolUse"].includes(native.stopReason)) throw new ModelFailure("schema_mismatch", terminal ? "ended" : "unknown", charge);
    const content: ModelContent[] = native.content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type !== "toolCall" || !["logs_read", "code_search"].includes(part.name) || part.argumentsError) throw new ModelFailure("schema_mismatch", terminal ? "ended" : "unknown", charge);
      return { type: "toolCall", id: part.id, name: part.name as "logs_read" | "code_search", arguments: part.arguments };
    });
    const text = content.filter((part) => part.type === "text").map((part) => part.text).join("");
    let candidate: unknown = text;
    try { candidate = JSON.parse(text) as unknown; } catch { /* A tool turn or plain text remains a neutral message. */ }
    return { candidate, message: { content, stopReason: native.stopReason as "stop" | "toolUse" }, actualMicrousd: usage.actualMicrousd, usageSource: usage.source };
  } };
}
