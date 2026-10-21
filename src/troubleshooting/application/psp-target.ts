import type { TroubleshootingCase } from "../domain/simulator.js";
import type { PspObservation } from "../domain/psp.js";
import type { ReadResult, VerifiedInbound } from "./ports.js";
import type { Identifier, LogRead, TargetResolution } from "./simulator-target.js";

type Selector = ({ readonly application: Identifier; readonly customer?: Identifier } | { readonly customer: Identifier; readonly application?: never }) &
  { readonly shop?: Identifier; readonly binding?: Identifier };
interface Target { readonly application: Identifier; readonly customer: Identifier; readonly shop: Identifier; readonly binding: Identifier; readonly boundAt: string }
interface Candidate { readonly candidateRef: string; readonly target: Target }
type State = { readonly kind: "locating"; readonly selector: Selector } | { readonly kind: "choosing"; readonly candidates: readonly Candidate[] } |
  { readonly kind: "fixed"; readonly target: Target };

export class PspTarget {
  readonly kind = "psp";
  private state: State;
  private observation: PspObservation | null = null;
  constructor(raw: VerifiedInbound["input"], safe: VerifiedInbound["input"]) {
    const identifier = (name: "applicationId" | "customerId" | "shopId" | "bindingId") => raw[name] && safe[name] ? { raw: raw[name], ref: safe[name] } : undefined;
    const application = identifier("applicationId"), customer = identifier("customerId"), shop = identifier("shopId"), binding = identifier("bindingId");
    const constraints = { ...(shop ? { shop } : {}), ...(binding ? { binding } : {}) };
    if (application) this.state = { kind: "locating", selector: { application, ...constraints } };
    else if (customer) this.state = { kind: "locating", selector: { customer, ...constraints } };
    else throw new Error("invalid_request");
  }
  private get selector(): Selector {
    if (this.state.kind === "choosing") throw new Error("invalid_request");
    return this.state.kind === "fixed" ? this.state.target : this.state.selector;
  }
  get applicationRef(): string | undefined { return this.state.kind === "choosing" ? undefined : this.selector.application?.ref; }
  query(): { applicationId?: string; customerId?: string; shopId?: string; bindingId?: string } {
    const selector = this.selector;
    if (!selector.application && !selector.customer) throw new Error("invalid_request");
    return { ...(selector.application ? { applicationId: selector.application.raw } : selector.customer ? { customerId: selector.customer.raw } : {}),
      ...(selector.shop ? { shopId: selector.shop.raw } : {}), ...(selector.binding ? { bindingId: selector.binding.raw } : {}) };
  }
  private selectCandidate(candidate: Candidate): void { this.state = Object.freeze({ kind: "fixed", target: candidate.target }); }
  select(content: Readonly<Record<string, unknown>>): boolean {
    if (this.state.kind !== "choosing" || Object.keys(content).some((key) => key !== "candidateRef")) return false;
    const candidate = this.state.candidates.find((candidate) => candidate.candidateRef === content.candidateRef);
    if (!candidate) return false;
    this.selectCandidate(candidate); return true;
  }
  resolve(raw: LogRead, safe: LogRead, questionId: string): TargetResolution {
    const selector = this.selector;
    if (safe.value && "kind" in safe.value && safe.value.kind === "psp_target_candidates") {
      const targets = safe.value.candidates;
      if (safe.completeness !== "complete" || safe.truncated || !safe.evidence.length || !raw.value || !("kind" in raw.value) || raw.value.kind !== "psp_target_candidates" ||
        (selector.application && selector.shop && selector.binding) || raw.value.candidates.length !== targets.length ||
        safe.evidence.some((item) => item.kind !== "log" || item.sourceRef !== "psp-log-source" || item.targetRef !== (selector.application?.ref ?? selector.customer?.ref)) ||
        targets.length < 1 || targets.length > 100 || targets.some((item) => !item.applicationId || !item.customerId || !item.shopId || !item.bindingId ||
          !Number.isFinite(Date.parse(item.boundAt)) || (selector.application && item.applicationId !== selector.application.ref) ||
          (selector.customer && item.customerId !== selector.customer.ref) || (selector.shop && item.shopId !== selector.shop.ref) || (selector.binding && item.bindingId !== selector.binding.ref)) ||
        new Set(targets.map((item) => JSON.stringify([item.applicationId, item.shopId, item.bindingId]))).size !== targets.length) throw new Error("invalid_request");
      const originals = raw.value.candidates;
      const candidates = targets.map((item, index): Candidate => {
        const original = originals[index]; if (!original) throw new Error("invalid_request");
        return Object.freeze({ candidateRef: `candidate-${index + 1}`, target: Object.freeze({ application: { raw: original.applicationId, ref: item.applicationId }, customer: { raw: original.customerId, ref: item.customerId },
          shop: { raw: original.shopId, ref: item.shopId }, binding: { raw: original.bindingId, ref: item.bindingId }, boundAt: item.boundAt }) });
      });
      if (candidates.length === 1 && candidates[0]) { this.selectCandidate(candidates[0]); return { kind: "selected" }; }
      this.state = { kind: "choosing", candidates };
      return { kind: "question", question: { questionId, requiredFields: ["candidateRef"], candidates: candidates.map(({ candidateRef, target }) => ({ candidateRef,
        applicationId: target.application.ref, shopId: target.shop.ref, bindingId: target.binding.ref, boundAt: target.boundAt })), format: "trusted target selection",
        prompt: "Select the evidenced shop and PSP binding; changing the investigation target requires a new case." } };
    }
    if (safe.value) {
      if (!("kind" in safe.value) || safe.value.kind !== "psp_observation" || !selector.shop || !selector.binding ||
        safe.value.applicationRef !== selector.application?.ref || safe.value.target.shopRef !== selector.shop.ref || safe.value.target.bindingRef !== selector.binding.ref ||
        (selector.customer && safe.value.customerRef !== selector.customer.ref) || (this.state.kind === "fixed" && Date.parse(safe.value.target.boundAt) !== Date.parse(this.state.target.boundAt))) throw new Error("invalid_request");
      if (!raw.value || !("kind" in raw.value) || raw.value.kind !== "psp_observation") throw new Error("invalid_request");
      if (this.state.kind !== "fixed") this.state = Object.freeze({ kind: "fixed", target: Object.freeze({
        application: Object.freeze({ raw: raw.value.applicationRef, ref: safe.value.applicationRef }),
        customer: Object.freeze({ raw: raw.value.customerRef, ref: safe.value.customerRef }),
        shop: Object.freeze({ raw: raw.value.target.shopRef, ref: safe.value.target.shopRef }),
        binding: Object.freeze({ raw: raw.value.target.bindingRef, ref: safe.value.target.bindingRef }), boundAt: safe.value.target.boundAt,
      }) });
    }
    return { kind: "observation" };
  }
  accept(read: LogRead, _evidenceRefs: readonly string[], investigation: TroubleshootingCase): void {
    if (read.value && (!("kind" in read.value) || read.value.kind !== "psp_observation")) throw new Error("invalid_request");
    const observation = read.value;
    if (observation) investigation.selectPspTarget(observation);
    this.observation = read.evidence.length ? observation : null;
  }
  diagnose(investigation: TroubleshootingCase, question: string, formedAt: string) { return investigation.diagnosePsp(this.observation, question, formedAt); }
}
