import type { CallContext, Ports } from "./ports.js";
import type { AuditDetails, CaseRecord } from "./records.js";
import type { ModelEnvelope, ModelResponse, ModelTurn } from "./model-contract.js";
import type { ReadyScope } from "./dependencies.js";
import type { PhaseExecution } from "./phase-execution.js";
import { beforeDeadline } from "./deadline.js";
import { CLEANUP_MS } from "./limits.js";
import { recordDenial } from "./authorization-audit.js";
import { validateModelEnvelope, validateModelResponse, validateModelTurn } from "./model-envelope.js";
import { ModelFailure } from "./model-failure.js";
import { retryModel } from "./model-retry.js";

interface ModelCase {
  current(): void;
  admit(context: CallContext, envelope: ModelEnvelope): Promise<void>;
  save(context: CallContext, record: CaseRecord): Promise<void>;
  stop(error: unknown): void;
}
type Attempt = { state: "preparing" } | { state: "prepared"; envelope: ModelEnvelope } | { state: "reserved"; envelope: ModelEnvelope };

/** Owns the whole model attempt policy; no provider failure escapes before its retry/settlement decision. */
export class ModelExecution {
  constructor(private readonly ports: Ports, private readonly scope: ReadyScope, private readonly phase: PhaseExecution,
    private readonly accounting: ModelCase, private readonly nextCallId: () => string) {}

  async generate(input: ModelTurn): Promise<ModelResponse> {
    const turn = structuredClone(input);
    try {
      return await retryModel(this.ports.clock, this.phase.context.deadline, this.nextCallId,
        (identity) => this.attempt(turn, Object.freeze({ ...this.phase.context, ...identity })));
    } catch (error) { this.accounting.stop(error); throw error; }
  }

  private async attempt(turn: ModelTurn, context: CallContext): Promise<ModelResponse> {
    const { ports, phase, accounting } = this;
    const check = () => { accounting.current(); if (ports.clock.now() >= context.deadline) throw new Error("timeout"); };
    const discarded = () => { try { check(); return false; } catch { return true; } };
    const details: AuditDetails = { model: this.scope.model.profile === "local_protocol"
      ? { profile: "local_protocol", protocol: "synthetic-responses-byte-pairs-1", schemaVersion: "model-turn-1", artifactVersion: "pi-ai-1.3.0" }
      : { profile: "memory_mock", protocol: "mock-json-byte-pairs-1", schemaVersion: "model-turn-1", artifactVersion: "offline-model-1" } };
    let invoked = false;
    let lifecycle: Attempt = { state: "preparing" };
    const original = async () => {
      check();
      if (!await ports.authorization.allows("model.generate", context)) { await recordDenial(ports.audit, context); throw new Error("denied"); }
      check();
      await ports.audit.intent(context, "model.generate", details);
      check(); invoked = true;
      let response: ModelResponse;
      try {
        if (!ports.sanitization.safe(turn)) throw new Error("unsafe_content");
        validateModelTurn(turn);
        try { response = await ports.model.generate(context, turn, async (request) => {
          check();
          if (lifecycle.state !== "preparing") throw new Error("contract_unverified");
          if (this.scope.model.state !== "enabled") throw new Error("contract_unverified");
          validateModelEnvelope(turn, request, this.scope.model.policy);
          if (request.profile !== this.scope.model.profile) throw new Error("contract_unverified");
          if (!ports.sanitization.safe(request)) throw new Error("unsafe_content");
          const envelope = structuredClone(request);
          lifecycle = { state: "prepared", envelope };
          await accounting.admit(context, envelope);
          if (!await ports.budget.reserve(context, envelope.planning.reservationMicrousd, async () => {
            if (!await ports.authorization.allows("model.generate", context)) { await recordDenial(ports.audit, context); throw new Error("denied"); }
            check();
          })) throw new Error("budget_exhausted");
          lifecycle = { state: "reserved", envelope };
          check();
        }); } catch (error) {
          if (lifecycle.state === "reserved") await ports.budget.settle(context,
            error instanceof ModelFailure ? error.charge?.actualMicrousd ?? null : null,
            { execution: error instanceof ModelFailure ? error.execution : "unknown", source: error instanceof ModelFailure ? error.charge?.source ?? "unknown" : "unknown" });
          throw error;
        }
        if (lifecycle.state !== "reserved") throw new Error("contract_unverified");
        const envelope = lifecycle.envelope;
        const usageSource = response.usageSource ?? (response.actualMicrousd !== null && response.actualMicrousd > 0 ? "mock_usage" : "unknown");
        await ports.budget.settle(context, response.actualMicrousd, { execution: "ended", source: usageSource });
        if (["mock_usage", "upstream_usage"].includes(usageSource) && response.actualMicrousd !== null && response.actualMicrousd > envelope.planning.reservationMicrousd) throw new Error("contract_unverified");
        validateModelResponse(response);
        if (!ports.sanitization.safe(response)) throw new Error("unsafe_content");
      } catch (error) {
        if (error instanceof Error && error.message === "audit_unavailable") throw error;
        await ports.audit.complete(context, "model.generate", discarded() ? "discarded" : "failed");
        throw error;
      }
      if (discarded()) { await ports.audit.complete(context, "model.generate", "discarded"); check(); }
      const result = ports.sanitization.sanitize(response, context.caseRef);
      if (!ports.sanitization.safe(result)) { await ports.audit.complete(context, "model.generate", "rejected"); throw new Error("unsafe_content"); }
      await accounting.save(context, { recordRef: `${context.callId}:output`, schemaVersion: 1, kind: "model_output", payload: result });
      await ports.audit.complete(context, "model.generate", "ok", details);
      check(); return result;
    };
    try { return await beforeDeadline(ports.clock, context.deadline, () => phase.run(original), phase.controller.signal); }
    catch (error) {
      if (invoked && (phase.controller.signal.aborted || ports.clock.now() >= context.deadline)) {
        void beforeDeadline(ports.clock, ports.clock.now() + CLEANUP_MS, () => phase.run(async () => {
          await ports.budget.settle(context, null, { execution: "unknown", source: "unknown" });
          await ports.audit.complete(context, "model.generate", "unknown");
        })).catch(() => {});
      }
      throw error;
    }
  }
}
