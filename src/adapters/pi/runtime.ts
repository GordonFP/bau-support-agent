import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { createProvider, InMemoryCredentialStore, InMemoryModelsStore, createAssistantMessageEventStream, type AssistantMessage, type Model, type StreamFunction } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { CallContext, Ports, RuntimeRequest } from "../../troubleshooting/application/ports.js";
import { MAX_ACTIVE_CASES } from "../../troubleshooting/application/limits.js";
import { validateModelResponse } from "../../troubleshooting/application/model-envelope.js";
import { reviewedSkill } from "./skill.js";
import { modelTurn } from "./transcript.js";
import type { ModelPolicy } from "../../troubleshooting/application/model-contract.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const safeReasons = new Set(["denied", "invalid_request", "contract_unverified", "schema_mismatch", "unavailable", "timeout", "cancelled", "rate_limited", "budget_exhausted", "unsafe_content", "audit_unavailable"]);
const safeError = (error: unknown) => new Error(error instanceof Error && safeReasons.has(error.message) ? error.message : "unavailable");
const model: Model<"bau-host-gateway"> = { id: "gpt6.1-sol", name: "Host gateway only", api: "bau-host-gateway", provider: "bau-host-gateway", baseUrl: "https://disabled.invalid",
  input: ["text"], reasoning: false, contextWindow: 24_000, maxTokens: 4_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
interface Owned {
  readonly controller: AbortController;
  readonly settled: ReturnType<typeof Promise.withResolvers<void>>;
  readonly pending: Set<Promise<unknown>>;
  session?: AgentSession;
  closing?: Promise<void>;
  failure?: Error;
  unsubscribe?: () => void;
}

export async function createPiRuntime(options: { readonly skillPath: string; readonly clock: Ports["clock"]; readonly modelPolicy?: ModelPolicy }): Promise<Ports["agent"]> {
  const body = await reviewedSkill(options.skillPath);
  const runs = new Map<string, Owned>();
  const track = <T>(owned: Owned, promise: Promise<T>): Promise<T> => {
    owned.pending.add(promise); void promise.then(() => owned.pending.delete(promise), () => owned.pending.delete(promise)); return promise;
  };
  const shutdown = (key: string, owned: Owned): Promise<void> => {
    if (owned.closing) return owned.closing;
    owned.controller.abort();
    const abort = Promise.resolve().then(() => owned.session?.abort());
    const closing = (async () => {
      const stopped = await Promise.allSettled([abort, owned.settled.promise]);
      await owned.session?.waitForIdle();
      await Promise.allSettled([...owned.pending]);
      owned.unsubscribe?.(); owned.session?.agent.reset(); owned.session?.sessionManager.newSession(); owned.session?.dispose();
      if (stopped.some((result) => result.status === "rejected")) throw new Error("unavailable");
      runs.delete(key); delete owned.session; delete owned.unsubscribe;
    })();
    owned.closing = closing; void closing.catch(() => {}); return closing;
  };
  return {
    async run(input, supplied) {
      const context: CallContext = Object.freeze({ ...input, resourceRefs: Object.freeze([...input.resourceRefs]) });
      const request: RuntimeRequest = Object.freeze({ ...supplied });
      const key = `${context.caseRef}:phase-${context.phaseId}`;
      if (runs.has(key) || runs.size >= MAX_ACTIVE_CASES) throw new Error("unavailable");
      const owned: Owned = { controller: new AbortController(), settled: Promise.withResolvers<void>(), pending: new Set() };
      runs.set(key, owned);
      const current = () => {
        if (context.signal.aborted || owned.controller.signal.aborted) throw new Error("cancelled");
        if (options.clock.now() >= context.deadline) throw new Error("timeout");
        if (owned.failure) throw owned.failure;
      };
      const abort = () => { owned.controller.abort(); void owned.session?.abort().catch(() => {}); };
      context.signal.addEventListener("abort", abort, { once: true });
      try {
        current();
        const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
        const stream: StreamFunction = (selected, transcript) => {
          const output = createAssistantMessageEventStream();
          const complete = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage => ({ role: "assistant", api: model.api,
            provider: model.provider, model: model.id, content, stopReason, usage: structuredClone(usage), timestamp: 0, ...(errorMessage ? { errorMessage } : {}) });
          void track(owned, (async () => {
            try {
              current();
              if (selected.api !== model.api || selected.provider !== model.provider || selected.id !== model.id) throw new Error("contract_unverified");
              const result = await request.generate(modelTurn(transcript, request.diagnose()));
              current(); validateModelResponse(result, options.modelPolicy);
              const message = complete(structuredClone([...result.message.content]), result.message.stopReason);
              output.push({ type: "start", partial: message }); output.push({ type: "done", reason: result.message.stopReason, message }); output.end(message);
            } catch (error) {
              owned.failure ??= safeError(error);
              const message = complete([], "error", owned.failure.message);
              output.push({ type: "error", reason: "error", error: message }); output.end(message);
            }
          })());
          return output;
        };
        runtime.registerNativeProvider(createProvider({ id: model.provider, auth: { apiKey: { name: "Host gateway only", resolve: async () => ({ auth: { apiKey: "host-gateway-only" }, source: "host" }) } },
          models: [model], api: { stream, streamSimple: stream } }));
        const resourceLoader: ResourceLoader = { getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }), getSkills: () => ({ skills: [], diagnostics: [] }),
          getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => body,
          getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => { throw new Error("denied"); }, reload: async () => {} };
        current();
        const created = await createAgentSession({ cwd: "/bau-runtime", agentDir: "/bau-runtime/disabled", model, modelRuntime: runtime, resourceLoader,
          sessionManager: SessionManager.inMemory("/bau-runtime"), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off" }),
          tools: ["logs_read", "code_search"], excludeTools: ["bash", "powershell", "read", "edit", "write", "find", "grep", "ls", "codemode", "tool_search", "mcp__*"],
          customTools: (["logs_read", "code_search"] as const).map((name) => ({ name, label: name, description: `Approved ${name} evidence for the host-bound case.`,
            parameters: Type.Object({}, { additionalProperties: false }), executionMode: "sequential", execute: async () => {
              try {
                current(); const result = await track(owned, request.invoke(name === "logs_read" ? "logs.read" : "code.search", null)); current();
                return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
              } catch (error) { owned.failure ??= safeError(error); throw owned.failure; }
            } })) });
        owned.session = created.session;
        owned.unsubscribe = created.session.subscribe((event) => {
          if (event.type === "agent_end" || event.type === "agent_settled") {
            try { request.progress({ state: event.type }); } catch (error) { owned.failure ??= safeError(error); }
          }
        });
        current();
        await created.session.prompt(request.question, { expandPromptTemplates: false });
        await created.session.waitForIdle(); await Promise.allSettled([...owned.pending]); current();
        try { return JSON.parse(created.session.getLastAssistantText() ?? "") as unknown; } catch { throw new Error("schema_mismatch"); }
      } catch (error) { throw safeError(error); }
      finally { context.signal.removeEventListener("abort", abort); owned.settled.resolve(); }
    },
    async abort(caseRef, phaseId = 1) { const key = `${caseRef}:phase-${phaseId}`, owned = runs.get(key); if (owned) await shutdown(key, owned); },
    async close(caseRef, phaseId = 1) { const key = `${caseRef}:phase-${phaseId}`, owned = runs.get(key); if (owned) await shutdown(key, owned); },
  };
}
