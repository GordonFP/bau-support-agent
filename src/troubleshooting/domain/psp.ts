import type { EvidenceReference, ObservedFact, ReportBase } from "./simulator.js";

// These are diagnostic observations in the owned synthetic contract, not verified production state names.
export type PspOutcome = "passed" | "failed" | "waiting" | "missing" | "timeout" | "unknown";
export interface PspPoint {
  readonly status: PspOutcome;
  readonly eventRef: string | null;
  readonly observedAt: string | null;
}
export interface PspObservation {
  readonly kind: "psp_observation";
  readonly applicationRef: string;
  readonly customerRef: string;
  readonly target: { readonly shopRef: string; readonly bindingRef: string; readonly platformRef: string; readonly pspRef: string;
    readonly recordRef: string; readonly boundAt: string };
  readonly first: PspPoint;
  readonly support: { readonly status: "supported" | "unsupported" | "unknown"; readonly basis: string | null;
    readonly version: string | null; readonly effectiveAt: string | null; readonly eventRef: string | null; readonly observedAt: string | null };
  readonly second: { readonly transaction: PspPoint; readonly tailThree: PspPoint };
  readonly final: { readonly status: "controlled" | "uncontrolled" | "unknown"; readonly eventRef: string | null; readonly observedAt: string | null };
  readonly linkedShops: readonly { readonly applicationRef: string; readonly customerRef: string; readonly shopRef: string;
    readonly bindingRef: string; readonly status: "passed" | "not_passed" | "unknown"; readonly eventRef: string | null; readonly observedAt: string | null }[];
}

interface Checkpoint { readonly status: PspOutcome; readonly evidenceRefs: readonly string[]; readonly observedAt: string | null }
export interface PspReport extends ReportBase {
  readonly scene: "psp";
  readonly psp: {
    readonly target: PspObservation["target"] | null;
    readonly first: Checkpoint;
    readonly support: PspObservation["support"] & { readonly evidenceRefs: readonly string[] };
    readonly second: { readonly status: "observed" | "not_applicable" | "unknown"; readonly transaction: Checkpoint; readonly tailThree: Checkpoint };
    readonly final: { readonly status: "controlled" | "uncontrolled" | "unknown"; readonly evidenceRefs: readonly string[]; readonly observedAt: string | null };
    readonly prerequisite: "met" | "unknown";
    readonly prerequisiteEvidenceRefs: readonly string[];
    readonly approval: "unknown";
    readonly amount: null;
  };
}

export function diagnosePsp(caseRef: string, observation: PspObservation | null, problem: string, formedAt: string,
  evidence: readonly EvidenceReference[], warnings: readonly string[]): PspReport {
  const refs = (event: { readonly eventRef: string | null; readonly observedAt: string | null }) => evidence.filter((item) =>
    item.kind === "log" && item.sourceRef === "psp-log-source" && item.targetRef === observation?.applicationRef && item.locator === event.eventRef &&
    event.observedAt !== null && item.observedAt === event.observedAt).map((item) => item.evidenceRef);
  const bindingRefs = observation ? refs({ eventRef: observation.target.recordRef, observedAt: observation.target.boundAt }) : [];
  const bound = bindingRefs.length ? observation : null;
  const unknown: Checkpoint = { status: "unknown", evidenceRefs: [], observedAt: null };
  const point = (value: PspPoint | undefined): Checkpoint => {
    const evidenceRefs = value && bound ? refs(value) : [];
    return value && evidenceRefs.length ? { status: value.status, evidenceRefs, observedAt: value.observedAt } : unknown;
  };
  const first = point(bound?.first);
  const supportRefs = bound ? refs(bound.support) : [];
  const supportKnown = bound && supportRefs.length && bound.support.basis && bound.support.version && bound.support.effectiveAt && bound.support.observedAt &&
    Number.isFinite(Date.parse(bound.support.effectiveAt)) && Date.parse(bound.support.effectiveAt) <= Date.parse(bound.support.observedAt);
  const support: PspReport["psp"]["support"] = supportKnown ? { ...bound!.support, evidenceRefs: supportRefs }
    : { status: "unknown", basis: null, version: null, effectiveAt: null, eventRef: null, observedAt: null, evidenceRefs: [] };
  const second: PspReport["psp"]["second"] = support.status === "unsupported" ? { status: "not_applicable", transaction: unknown, tailThree: unknown }
    : support.status === "supported" ? { status: "observed", transaction: point(bound?.second.transaction), tailThree: point(bound?.second.tailThree) }
    : { status: "unknown", transaction: unknown, tailThree: unknown };
  const finalRefs = bound ? refs(bound.final) : [];
  const final: PspReport["psp"]["final"] = bound && finalRefs.length ? { status: bound.final.status, evidenceRefs: finalRefs, observedAt: bound.final.observedAt }
    : { status: "unknown", evidenceRefs: [], observedAt: null };
  const passed = (bound?.linkedShops ?? []).filter((shop) => shop.applicationRef === bound!.applicationRef && shop.customerRef === bound!.customerRef &&
    shop.status === "passed" && shop.shopRef && shop.bindingRef && refs(shop).length);
  const prerequisiteEvidenceRefs = [...new Set([...(final.status === "controlled" ? finalRefs : []), ...passed.flatMap(refs)])];
  const limitations = ["Synthetic PSP contract only; actual fields, quality and historical production deployment are unverified.",
    "Point observations do not cover every customer shop or establish credit approval or amount.", ...warnings];
  if (evidence.some((item) => item.completeness !== "complete" || item.truncated)) limitations.push("Source completeness is limited; per-evidence completeness and truncation remain explicit.");
  if (!bound) limitations.push("Target shop and PSP binding evidence is unavailable; no verification path can be established.");
  if (support.status === "unknown") limitations.push("Second-step support is unknown; missing logs or a missing version do not establish unsupported applicability.");
  const facts: ObservedFact[] = [];
  const fact = (statement: string, evidenceRefs: readonly string[], observedAt: string | null) => {
    if (evidenceRefs.length) facts.push({ statement, evidenceRefs, scope: bound?.target.bindingRef ?? "unresolved", observedAt,
      limitations: [] });
  };
  if (bound) fact(`Target shop ${bound.target.shopRef} is associated with PSP binding ${bound.target.bindingRef}.`, bindingRefs, bound.target.boundAt);
  if (first.status !== "unknown") fact(`Observed first shop match: ${first.status}.`, first.evidenceRefs, first.observedAt);
  if (support.status !== "unknown") fact(`Second-step combination support: ${support.status}; basis ${support.basis}, version ${support.version}, effective ${support.effectiveAt}.`, support.evidenceRefs, support.observedAt);
  if (second.status === "not_applicable") fact("Second step: not applicable, not executed passed.", support.evidenceRefs, support.observedAt);
  for (const [name, value] of [["transaction", second.transaction], ["tail-three", second.tailThree]] as const) if (value.status !== "unknown") fact(`Observed second-step ${name} check: ${value.status}.`, value.evidenceRefs, value.observedAt);
  if (final.status !== "unknown") fact(`Observed final shop status: ${final.status}.`, final.evidenceRefs, final.observedAt);
  for (const shop of passed) fact(`Linked shop ${shop.shopRef} passed at the cited observation time.`, refs(shop), shop.observedAt);
  if (prerequisiteEvidenceRefs.length) fact("At least one linked passed shop satisfies the PSP initiation prerequisite only; approval and amount are unverified.", prerequisiteEvidenceRefs, final.observedAt ?? passed[0]?.observedAt ?? null);
  return { schemaVersion: 1, reportRef: `${caseRef}:report:1`, caseRef, scene: "psp", problem,
    targetSummary: bound ? `${bound.applicationRef}/${bound.target.shopRef}/${bound.target.bindingRef}` : "unresolved", facts, possibleCauses: [], evidence,
    confidence: "Point observations only; concrete branches need matching frozen code and execution.", limitations,
    humanNextSteps: ["Verify binding, support version and correlated execution.", "Review customer scope, approval and amount evidence separately; keep business data read-only."],
    diagnosticStatus: facts.length ? "lead" : "insufficient_evidence", formedAt, policyVersion: "mock-policy-1", artifactVersion: "offline-psp-1",
    psp: { target: bound?.target ?? null, first, support, second, final, prerequisite: prerequisiteEvidenceRefs.length ? "met" : "unknown",
      prerequisiteEvidenceRefs, approval: "unknown", amount: null } };
}
