export type Completeness = "complete" | "partial" | "unknown";
export type Authorization = "active" | "cancelled" | "unknown";

export interface SimulatorObservation {
  readonly applicationRef: string;
  readonly submittedOn: string;
  readonly shops: readonly {
    readonly shopRef: string;
    readonly authorization: Authorization;
    readonly completeThrough: string | null;
    readonly coverageComplete: boolean;
  }[];
  readonly calculation: {
    readonly started: boolean | null;
    readonly succeeded: boolean | null;
    readonly estimate: string | null;
  };
  readonly causes: readonly { readonly statement: string; readonly kind: "rate_limited" | "authorization_cancelled" | "program_error" }[];
}

export interface EvidenceReference {
  readonly evidenceRef: string;
  readonly caseRef: string;
  readonly sourceRef: string;
  readonly kind: "log" | "code";
  readonly locator: string;
  readonly observedAt: string | null;
  readonly acquiredAt: string;
  readonly completeness: Completeness;
  readonly truncated: boolean;
  readonly targetRef: string;
  readonly sanitizationVersion: string;
  readonly auditRef: string;
  readonly text: string;
  readonly log?: { readonly from: string; readonly to: string; readonly queryRef: string };
  readonly code?: {
    readonly repositoryRef: string;
    readonly branch: "main" | "master";
    readonly commit: string;
    readonly snapshotRef: string;
    readonly indexedAt: string;
    readonly receiptRef: string;
  };
}

export interface ObservedFact {
  readonly statement: string;
  readonly evidenceRefs: readonly string[];
  readonly scope: string;
  readonly observedAt: string | null;
  readonly limitations: readonly string[];
}

export interface DiagnosticReport {
  readonly schemaVersion: 1;
  readonly reportRef: string;
  readonly caseRef: string;
  readonly scene: "simulator";
  readonly problem: string;
  readonly targetSummary: string;
  readonly facts: readonly ObservedFact[];
  readonly possibleCauses: readonly ObservedFact[];
  readonly evidence: readonly EvidenceReference[];
  readonly confidence: string;
  readonly limitations: readonly string[];
  readonly humanNextSteps: readonly string[];
  readonly diagnosticStatus: "located" | "lead" | "insufficient_evidence";
  readonly formedAt: string;
  readonly policyVersion: string;
  readonly artifactVersion: string;
  readonly simulator: {
    readonly submittedOn: string | null;
    readonly shopCount: number;
    readonly dataReadiness: { readonly satisfied: number; readonly missing: number; readonly unknown: number };
    readonly shops: readonly {
      readonly shopRef: string;
      readonly authorization: Authorization;
      readonly targetDate: string;
      readonly completeThrough: string | null;
      readonly readiness: "satisfied" | "missing" | "unknown";
      readonly evidenceRefs: readonly string[];
    }[];
    readonly calculation: SimulatorObservation["calculation"];
  };
}

export class TroubleshootingCase {
  private readonly evidence = new Map<string, EvidenceReference>();
  private ended = false;
  private awaiting = false;
  private phase = 1;
  private selectedTarget: string | undefined;
  private materialRevision = 0;

  constructor(readonly caseRef: string) {}

  get materialVersion(): number { return this.materialRevision; }

  selectTarget(applicationRef: string): void {
    if (this.ended || (this.selectedTarget !== undefined && this.selectedTarget !== applicationRef)) throw new Error("invalid_request");
    if (this.selectedTarget !== applicationRef) this.materialRevision++;
    this.selectedTarget = applicationRef;
  }

  awaitInformation(): void {
    if (this.ended || this.awaiting) throw new Error("invalid_request");
    this.awaiting = true;
  }

  resume(): number {
    if (this.ended || !this.awaiting) throw new Error("invalid_request");
    this.awaiting = false;
    return ++this.phase;
  }

  isCurrentPhase(phaseId: number): boolean {
    return !this.ended && !this.awaiting && this.phase === phaseId;
  }

  stop(): void {
    this.ended = true;
    this.awaiting = false;
  }

  acceptEvidence(evidence: EvidenceReference): void {
    if (this.ended || this.awaiting || evidence.caseRef !== this.caseRef || this.evidence.has(evidence.evidenceRef)) {
      throw new Error("invalid_request");
    }
    this.evidence.set(evidence.evidenceRef, immutable(evidence));
    this.materialRevision++;
  }

  diagnose(observation: SimulatorObservation | null, problem: string, formedAt: string): DiagnosticReport {
    const evidence = [...this.evidence.values()];
    const logEvidence = evidence.filter((item) => item.kind === "log");
    const logRefs = logEvidence.map((item) => item.evidenceRef);
    const observedAt = logEvidence[0]?.observedAt ?? null;
    const limitations = ["Synthetic Mock evidence; actual source fields, SDKs and diagnostic quality are unverified.",
      "A fixed code snapshot does not prove the historical production deployment version."];
    for (const item of evidence) {
      if (item.completeness !== "complete" || item.truncated) limitations.push(`${item.evidenceRef}: ${item.completeness}; truncated=${item.truncated}.`);
      if (item.observedAt === null && item.kind === "log") limitations.push(`${item.evidenceRef}: event observation time is unknown.`);
    }
    const shops = (observation?.shops ?? []).map((shop) => {
      const readiness = !shop.coverageComplete || shop.completeThrough === null ? "unknown"
        : shop.completeThrough >= observation!.submittedOn ? "satisfied" : "missing";
      return { shopRef: shop.shopRef, authorization: shop.authorization, targetDate: observation!.submittedOn,
        completeThrough: shop.completeThrough, readiness, evidenceRefs: logRefs } as const;
    });
    const dataReadiness = { satisfied: 0, missing: 0, unknown: 0 };
    for (const shop of shops) dataReadiness[shop.readiness]++;
    const fact = (statement: string): ObservedFact => ({ statement, evidenceRefs: logRefs,
      scope: observation?.applicationRef ?? "unresolved", observedAt, limitations: [] });
    const facts: ObservedFact[] = [];
    if (observation && logRefs.length) {
      facts.push(fact(`${dataReadiness.satisfied} of ${shops.length} submitted shops have verified complete data through ${observation.submittedOn}; ${dataReadiness.missing} missing, ${dataReadiness.unknown} unknown.`));
      if (observation.calculation.started !== null) facts.push(fact(`Calculation execution observed: ${observation.calculation.started}.`));
      if (observation.calculation.succeeded !== null) facts.push(fact(`Calculation success observed: ${observation.calculation.succeeded}.`));
      if (observation.calculation.estimate !== null) facts.push(fact(`Observed estimate: ${observation.calculation.estimate}.`));
    }
    if (!observation || !logRefs.length) limitations.push("Application evidence is unavailable; zero observations do not prove that an event did not happen.");
    if (observation?.calculation.started === null || !observation) limitations.push("Calculation execution is unknown.");
    if (observation?.calculation.succeeded === null || !observation) limitations.push("Calculation success is unknown.");
    if (observation?.calculation.estimate === null || !observation) limitations.push("No estimate result has been verified.");
    const gaps = shops.filter((shop) => shop.readiness !== "satisfied").map((shop) => shop.shopRef);
    return immutable({ schemaVersion: 1, reportRef: `${this.caseRef}:report:1`, caseRef: this.caseRef,
      scene: "simulator", problem, targetSummary: observation?.applicationRef ?? "unresolved", facts,
      possibleCauses: logRefs.length ? (observation?.causes ?? []).map((cause) => fact(cause.statement)) : [], evidence,
      confidence: "Limited to the cited observations; causal explanations require human verification.", limitations,
      humanNextSteps: gaps.length ? [`Verify authorization and complete data coverage for ${gaps.join(", ")}.`,
        "Verify corresponding execution evidence before attributing a cause or advising recovery."]
        : ["Verify calculation execution, success and the estimate result separately."],
      diagnosticStatus: facts.length ? "lead" : "insufficient_evidence", formedAt,
      policyVersion: "mock-policy-1", artifactVersion: "offline-simulator-1", simulator: {
        submittedOn: observation?.submittedOn ?? null, shopCount: shops.length, dataReadiness, shops,
        calculation: observation?.calculation ?? { started: null, succeeded: null, estimate: null },
      } });
  }

  finish(candidate: unknown, expected: DiagnosticReport): DiagnosticReport {
    // The first offline slice only accepts the deterministic evidence-backed draft.
    // A future model adapter must still submit a candidate through this boundary.
    if (this.ended || JSON.stringify(candidate) !== JSON.stringify(expected)) throw new Error("unsafe_content");
    for (const fact of [...expected.facts, ...expected.possibleCauses]) {
      if (!fact.evidenceRefs.length || fact.evidenceRefs.some((ref) => !this.evidence.has(ref))) throw new Error("invalid_request");
    }
    this.ended = true;
    return immutable(expected);
  }
}

export function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) immutable(nested);
  }
  return value;
}
