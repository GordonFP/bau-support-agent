import type { EvidenceReference, ObservedFact, ReportBase } from "./simulator.js";

// These are diagnostic observations in the owned synthetic contract, not verified production state names.
export type PspOutcome = "passed" | "failed" | "waiting" | "missing" | "timeout" | "unknown";
export interface PspPoint {
  readonly status: PspOutcome;
  readonly eventRef: string | null;
  readonly observedAt: string | null;
}
export interface PspRule {
  readonly ruleRef: string;
  readonly stage: "first" | "transaction" | "tail_three";
  readonly outcome: "waiting" | "missing" | "failed" | "timeout" | "fallback";
  readonly prerequisite: "one_passed_shop" | "all_shops_passed";
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
  readonly executions?: readonly (Pick<PspRule, "ruleRef" | "stage" | "outcome"> & { readonly codeCommit: string; readonly eventRef: string; readonly observedAt: string })[];
}

interface Checkpoint { readonly status: PspOutcome; readonly evidenceRefs: readonly string[]; readonly observedAt: string | null }
export interface PspReport extends ReportBase {
  readonly scene: "psp";
  readonly draftVersion: string;
  readonly psp: {
    readonly target: PspObservation["target"] | null;
    readonly first: Checkpoint;
    readonly support: PspObservation["support"] & { readonly evidenceRefs: readonly string[] };
    readonly second: { readonly status: "observed" | "not_applicable" | "unknown"; readonly transaction: Checkpoint; readonly tailThree: Checkpoint };
    readonly final: { readonly status: "controlled" | "uncontrolled" | "unknown"; readonly evidenceRefs: readonly string[]; readonly observedAt: string | null };
    readonly prerequisite: "met" | "unknown";
    readonly prerequisiteEvidenceRefs: readonly string[];
    readonly approval: "unknown";
    readonly initiation: "unknown";
    readonly amount: null;
    readonly branches: readonly { readonly stage: PspRule["stage"]; readonly outcome: PspRule["outcome"]; readonly evidenceRefs: readonly string[]; readonly observedAt: string }[];
    readonly conflicts: readonly ObservedFact[];
  };
}

export function diagnosePsp(caseRef: string, observation: PspObservation | null, problem: string, formedAt: string,
  evidence: readonly EvidenceReference[], warnings: readonly string[], draftVersion: string): PspReport {
  const refs = (event: { readonly eventRef: string | null; readonly observedAt: string | null }) => evidence.filter((item) =>
    item.kind === "log" && item.sourceRef === "psp-log-source" && item.targetRef === observation?.applicationRef && item.locator === event.eventRef &&
    event.observedAt !== null && Number.isFinite(Date.parse(event.observedAt)) && Date.parse(event.observedAt) <= Date.parse(formedAt) && item.observedAt === event.observedAt).map((item) => item.evidenceRef);
  const bindingRefs = observation ? refs({ eventRef: observation.target.recordRef, observedAt: observation.target.boundAt }) : [];
  const bound = bindingRefs.length ? observation : null;
  const targetRefs = (event: { readonly eventRef: string | null; readonly observedAt: string | null }) => bound && event.observedAt &&
    Date.parse(event.observedAt) >= Date.parse(bound.target.boundAt) ? refs(event) : [];
  const unknown: Checkpoint = { status: "unknown", evidenceRefs: [], observedAt: null };
  const point = (value: PspPoint | undefined): Checkpoint => {
    const evidenceRefs = value && bound ? targetRefs(value) : [];
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
  const finalRefs = bound ? targetRefs(bound.final) : [];
  const final: PspReport["psp"]["final"] = bound && finalRefs.length ? { status: bound.final.status, evidenceRefs: finalRefs, observedAt: bound.final.observedAt }
    : { status: "unknown", evidenceRefs: [], observedAt: null };
  const conflicts: ObservedFact[] = evidence.filter((item) => item.kind === "code" && item.targetRef === bound?.applicationRef && item.code?.pspRule?.prerequisite === "all_shops_passed")
    .map((item) => ({ statement: "Frozen synthetic code requires all shops; the reviewed PSP business policy requires one passed shop. Neither resolves the policy conflict automatically.",
      evidenceRefs: [item.evidenceRef], scope: bound!.target.bindingRef, observedAt: null, limitations: ["Code is not proof this branch executed."] }));
  const groups = new Map<string, PspObservation["linkedShops"][number][]>();
  const linkedHistory: PspObservation["linkedShops"][number][] = [];
  for (const shop of bound?.linkedShops ?? []) {
    if (shop.applicationRef !== bound!.applicationRef || shop.customerRef !== bound!.customerRef || !shop.shopRef || !shop.bindingRef || !refs(shop).length) continue;
    if (shop.shopRef === bound!.target.shopRef && shop.bindingRef === bound!.target.bindingRef && !targetRefs(shop).length) continue;
    linkedHistory.push(shop);
    const key = JSON.stringify([shop.shopRef, shop.bindingRef]);
    groups.set(key, [...(groups.get(key) ?? []), shop]);
  }
  if (bound && finalRefs.length) {
    const key = JSON.stringify([bound.target.shopRef, bound.target.bindingRef]);
    groups.set(key, [...(groups.get(key) ?? []), { applicationRef: bound.applicationRef, customerRef: bound.customerRef,
      shopRef: bound.target.shopRef, bindingRef: bound.target.bindingRef,
      status: final.status === "controlled" ? "passed" : final.status === "uncontrolled" ? "not_passed" : "unknown",
      eventRef: bound.final.eventRef, observedAt: final.observedAt }]);
  }
  const passed: PspObservation["linkedShops"][number][] = [];
  for (const shops of groups.values()) {
    const latest = Math.max(...shops.map((shop) => Date.parse(shop.observedAt!)));
    const current = shops.filter((shop) => Date.parse(shop.observedAt!) === latest);
    const sourceConflict = new Set(current.map((shop) => shop.status)).size > 1;
    if (sourceConflict) {
      conflicts.push({ statement: "Conflicting current PSP shop outcomes require human source reconciliation; this shop cannot establish the prerequisite.",
        evidenceRefs: [...new Set(current.flatMap(refs))], scope: current[0]!.bindingRef,
        observedAt: current[0]!.observedAt, limitations: ["No current authoritative outcome selected."] });
    } else if (current[0]!.status === "passed") passed.push(current[0]!);
  }
  const prerequisiteEvidenceRefs = [...new Set(passed.flatMap(refs))];
  const branches: PspReport["psp"]["branches"] = (bound?.executions ?? []).flatMap((execution) => {
    const logRefs = refs(execution);
    const codeRefs = evidence.filter((item) => item.kind === "code" && item.targetRef === bound!.applicationRef &&
      item.code?.commit === execution.codeCommit && item.code.pspRule?.ruleRef === execution.ruleRef &&
      item.code.pspRule.stage === execution.stage && item.code.pspRule.outcome === execution.outcome).map((item) => item.evidenceRef);
    if (!logRefs.length || !codeRefs.length || Date.parse(execution.observedAt) < Date.parse(bound!.target.boundAt) ||
      (execution.stage !== "first" && support.status !== "supported")) return [];
    return [{ stage: execution.stage, outcome: execution.outcome, evidenceRefs: [...logRefs, ...codeRefs], observedAt: execution.observedAt }];
  });
  const limitations = ["Synthetic PSP contract only; actual fields, quality and historical production deployment are unverified.",
    "Point observations do not cover every customer shop or establish credit approval or amount.", ...warnings];
  if (evidence.some((item) => item.completeness !== "complete" || item.truncated)) limitations.push("Source completeness is limited; per-evidence completeness and truncation remain explicit.");
  if (!bound) limitations.push("Target shop and PSP binding evidence is unavailable; no verification path can be established.");
  if (bound && [bound.first, bound.second.transaction, bound.second.tailThree, bound.final,
    ...bound.linkedShops.filter((shop) => shop.shopRef === bound.target.shopRef && shop.bindingRef === bound.target.bindingRef)]
    .some((event) => event.observedAt && Date.parse(event.observedAt) < Date.parse(bound.target.boundAt))) {
    limitations.push("Target outcomes observed before this binding cannot establish its current verification or prerequisite.");
  }
  if (support.status === "unknown") limitations.push("Second-step support is unknown; missing logs or a missing version do not establish unsupported applicability.");
  if ((bound?.executions?.length ?? 0) > branches.length) limitations.push("An execution claim lacks matching frozen code, correlation or applicability; no concrete branch is established for that claim.");
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
  for (const shop of linkedHistory) facts.push({ statement: `Linked shop ${shop.shopRef} was observed ${shop.status} at the cited observation time.`,
    evidenceRefs: refs(shop), scope: shop.bindingRef, observedAt: shop.observedAt,
    limitations: ["Historical point observation; the current prerequisite uses the latest consistent outcome for this binding."] });
  for (const shop of passed) facts.push({ statement: "At least one linked passed shop satisfies the PSP initiation prerequisite only; approval and amount are unverified.",
    evidenceRefs: refs(shop), scope: shop.bindingRef, observedAt: shop.observedAt, limitations: [] });
  for (const branch of branches) fact(`Correlated synthetic ${branch.stage} branch executed: ${branch.outcome}; this is not a universal fallback rule.`, branch.evidenceRefs, branch.observedAt);
  return { schemaVersion: 1, reportRef: `${caseRef}:report:1`, caseRef, scene: "psp", draftVersion, problem,
    targetSummary: bound ? `${bound.applicationRef}/${bound.target.shopRef}/${bound.target.bindingRef}` : "unresolved", facts, possibleCauses: [], evidence,
    confidence: "Point observations only; concrete branches need matching frozen code and execution.", limitations,
    humanNextSteps: ["Verify binding, support version and correlated execution.", "Review customer scope, initiation, approval and amount evidence separately; keep business data read-only.",
      ...(conflicts.length ? ["Resolve the displayed code/business policy conflict with the responsible humans before changing any business rule."] : [])],
    diagnosticStatus: branches.length ? "located" : facts.length ? "lead" : "insufficient_evidence", formedAt, policyVersion: "mock-policy-1", artifactVersion: "offline-psp-1",
    psp: { target: bound?.target ?? null, first, support, second, final, prerequisite: prerequisiteEvidenceRefs.length ? "met" : "unknown",
      prerequisiteEvidenceRefs, initiation: "unknown", approval: "unknown", amount: null, branches, conflicts } };
}

// Enumerated observation points of the owned contract, without inferring missing events.
export function pspEvents(value: PspObservation) {
  return [{ eventRef: value.target.recordRef, observedAt: value.target.boundAt, target: value.target }, value.first, value.support,
    value.second.transaction, value.second.tailThree, value.final, ...value.linkedShops, ...(value.executions ?? [])];
}
