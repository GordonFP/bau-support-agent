import type { PspObservation } from "../../src/troubleshooting/domain/psp.js";

export const pspFixture: PspObservation = {
  kind: "psp_observation", applicationRef: "SYNTHETIC-SECRET-APPLICATION", customerRef: "SYNTHETIC-SECRET-CUSTOMER",
  target: { shopRef: "SYNTHETIC-SECRET-SHOP", bindingRef: "SYNTHETIC-SECRET-BINDING", platformRef: "synthetic-platform",
    pspRef: "synthetic-psp", recordRef: "synthetic-verification", boundAt: "2026-10-18T10:00:00.000Z" },
  first: { status: "passed", eventRef: "first-match", observedAt: "2026-10-18T12:00:00.000Z" },
  support: { status: "unsupported", basis: "synthetic-combination-register", version: "synthetic-capabilities-1", effectiveAt: "2026-10-01T00:00:00.000Z",
    eventRef: "combination-support", observedAt: "2026-10-18T12:00:01.000Z" },
  second: { transaction: { status: "unknown", eventRef: null, observedAt: null }, tailThree: { status: "unknown", eventRef: null, observedAt: null } },
  final: { status: "controlled", eventRef: "source-final", observedAt: "2026-10-18T12:00:02.000Z" }, linkedShops: [],
};

export function pspScenario(mode: string): PspObservation {
  const value = structuredClone(pspFixture);
  if (mode === "unsupported" || mode === "conflict") return value;
  if (mode === "unknown") return { ...value, support: { ...value.support, status: "unknown", basis: null, version: null, effectiveAt: null, eventRef: null, observedAt: null } };
  if (mode === "two_pass" || mode === "tail_failure") return { ...value, support: { ...value.support, status: "supported" },
    second: { transaction: { status: "passed", eventRef: "transaction-result", observedAt: "2026-10-18T12:00:02.000Z" },
      tailThree: { status: mode === "two_pass" ? "passed" : "failed", eventRef: "tail-three-result", observedAt: "2026-10-18T12:00:03.000Z" } },
    final: { ...value.final, status: mode === "two_pass" ? "controlled" : "uncontrolled", observedAt: "2026-10-18T12:00:04.000Z" } };
  if (mode === "other_passed") return { ...value, final: { ...value.final, status: "uncontrolled" }, linkedShops: [
    { applicationRef: value.applicationRef, customerRef: value.customerRef, shopRef: "other-shop", bindingRef: "other-binding", status: "passed", eventRef: "other-passed", observedAt: "2026-10-18T12:00:03.000Z" },
    { applicationRef: value.applicationRef, customerRef: value.customerRef, shopRef: "unknown-shop", bindingRef: "unknown-binding", status: "unknown", eventRef: null, observedAt: null },
  ] };
  if (mode === "waiting" || mode === "missing" || mode === "failed" || mode === "timeout" || mode === "fallback") return { ...value,
    first: { ...value.first, status: mode === "fallback" ? "unknown" : mode }, final: { ...value.final, status: "unknown" },
    executions: [{ ruleRef: `synthetic-${mode}`, stage: "first", outcome: mode, codeCommit: "1".repeat(40), eventRef: `executed-${mode}`, observedAt: "2026-10-18T12:00:01.000Z" }] };
  throw new Error("invalid_synthetic_scenario");
}
