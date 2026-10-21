import type { SimulatorObservation, TroubleshootingCase } from "../domain/simulator.js";
import type { InformationQuestion, Ports, ReadResult, VerifiedInbound } from "./ports.js";

export interface Identifier { readonly raw: string; readonly ref: string }
export type LogRead = Awaited<ReturnType<Ports["logs"]["read"]>>;
export type TargetResolution = { readonly kind: "selected" } | { readonly kind: "question"; readonly question: InformationQuestion } | { readonly kind: "observation" };
interface Candidate { readonly candidateRef: string; readonly application: Identifier; readonly submittedAt: string }
type State = { readonly kind: "locating"; readonly customer: Identifier } |
  { readonly kind: "choosing"; readonly candidates: readonly Candidate[] } |
  { readonly kind: "fixed"; readonly application: Identifier; readonly submittedOn?: string };

export class SimulatorTarget {
  readonly kind = "simulator";
  private state: State;
  private observation: SimulatorObservation | null = null;
  constructor(raw: VerifiedInbound["input"], safe: VerifiedInbound["input"]) {
    if (raw.applicationId && safe.applicationId) this.state = { kind: "fixed", application: { raw: raw.applicationId, ref: safe.applicationId } };
    else if (raw.customerId && safe.customerId) this.state = { kind: "locating", customer: { raw: raw.customerId, ref: safe.customerId } };
    else throw new Error("invalid_request");
  }
  get applicationRef(): string | undefined { return this.state.kind === "fixed" ? this.state.application.ref : undefined; }
  query(): { applicationId: string } | { customerId: string } {
    if (this.state.kind === "fixed") return { applicationId: this.state.application.raw };
    if (this.state.kind === "locating") return { customerId: this.state.customer.raw };
    throw new Error("invalid_request");
  }
  private selectCandidate(candidate: Candidate): void { this.state = Object.freeze({ kind: "fixed", application: candidate.application }); }
  select(content: Readonly<Record<string, unknown>>): boolean {
    if (this.state.kind !== "choosing" || Object.keys(content).some((key) => !["submittedAt", "candidateRef"].includes(key))) return false;
    const matches = this.state.candidates.filter((candidate) => candidate.submittedAt === content.submittedAt &&
      (content.candidateRef === undefined || content.candidateRef === candidate.candidateRef));
    if (matches.length !== 1 || !matches[0]) return false;
    this.selectCandidate(matches[0]); return true;
  }
  resolve(raw: LogRead, safe: LogRead, questionId: string): TargetResolution {
    if (safe.value && "kind" in safe.value && safe.value.kind === "application_candidates") {
      if (safe.completeness !== "complete" || safe.truncated || !safe.evidence.length) throw new Error("contract_unverified");
      if (this.state.kind !== "locating" || safe.value.customerRef !== this.state.customer.ref ||
        !raw.value || !("kind" in raw.value) || raw.value.kind !== "application_candidates" ||
        safe.value.candidates.length < 1 || safe.value.candidates.length > 100 || raw.value.candidates.length !== safe.value.candidates.length ||
        safe.value.candidates.some((candidate) => !candidate.applicationId || !Number.isFinite(Date.parse(candidate.submittedAt)))) throw new Error("invalid_request");
      const rawCandidates = raw.value.candidates;
      const candidates = safe.value.candidates.map((candidate, index): Candidate => {
        const original = rawCandidates[index]; if (!original) throw new Error("invalid_request");
        return Object.freeze({ candidateRef: `candidate-${index + 1}`, application: Object.freeze({ raw: original.applicationId, ref: candidate.applicationId }), submittedAt: candidate.submittedAt });
      });
      if (candidates.length === 1 && candidates[0]) { this.selectCandidate(candidates[0]); return { kind: "selected" }; }
      this.state = { kind: "choosing", candidates };
      return { kind: "question", question: { questionId, requiredFields: ["submittedAt"], candidates: candidates.map(({ candidateRef, submittedAt }) => ({ candidateRef, submittedAt })),
        format: "ISO-8601 UTC", prompt: "Select the submission time for this customer's application; do not change the investigation target." } };
    }
    if (safe.value && "kind" in safe.value) throw new Error("invalid_request");
    const observation = safe.value;
    if (observation && (this.state.kind !== "fixed" || observation.applicationRef !== this.state.application.ref ||
      (this.state.submittedOn !== undefined && observation.submittedOn !== this.state.submittedOn))) throw new Error("invalid_request");
    return { kind: "observation" };
  }
  accept(read: LogRead, evidenceRefs: readonly string[], investigation: TroubleshootingCase): void {
    if (read.value && "kind" in read.value) throw new Error("invalid_request");
    this.observation = read.evidence.length ? read.value : null;
    investigation.acceptSimulatorObservation(this.observation, evidenceRefs);
    if (this.observation && this.state.kind === "fixed") this.state = Object.freeze({ ...this.state, submittedOn: this.observation.submittedOn });
  }
  diagnose(investigation: TroubleshootingCase, question: string, formedAt: string) { return investigation.diagnose(this.observation, question, formedAt); }
}
