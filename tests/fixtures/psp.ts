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
