import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { pspFixture } from "../fixtures/psp.js";

test("a PSP investigation with no observations preserves unknown applicability and cannot borrow Simulator shop readiness", async () => {
  const mock = createMockTroubleshooting({ pspObservation: null });
  const accepted = await mock.receive({ input: { scenario: "psp", applicationId: "SYNTHETIC-SECRET-APPLICATION",
    shopId: "SYNTHETIC-SECRET-SHOP", bindingId: "SYNTHETIC-SECRET-BINDING", question: "Why is this shop uncontrolled?" } });
  assert.equal(accepted.status, "accepted"); await mock.closed;
  const delivered = await mock.delivery.next();
  const report = delivered.report;
  assert.ok(report.scene === "psp"); assert.equal("simulator" in report, false);
  assert.equal(report.psp.support.status, "unknown"); assert.equal(report.psp.prerequisite, "unknown");
  assert.equal(report.psp.approval, "unknown"); assert.equal(report.psp.amount, null);
  assert.doesNotMatch(JSON.stringify(delivered), /SYNTHETIC-SECRET|all submitted shops|10 submitted shops/);
});

test("an independently evidenced unsupported combination reports second-step not applicable rather than executed passed", async () => {
  const mock = createMockTroubleshooting({ pspObservation: pspFixture });
  await mock.receive({ input: { scenario: "psp", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef,
    bindingId: pspFixture.target.bindingRef, question: "Explain this PSP verification." } });
  await mock.closed;
  const report = (await mock.delivery.next()).report;
  assert.ok(report.scene === "psp");
  assert.equal(report.psp.first.status, "passed"); assert.equal(report.psp.support.status, "unsupported");
  assert.equal(report.psp.support.basis, "synthetic-combination-register"); assert.equal(report.psp.support.version, "synthetic-capabilities-1");
  assert.equal(report.psp.support.effectiveAt, "2026-10-01T00:00:00.000Z");
  assert.equal(report.psp.second.status, "not_applicable"); assert.equal(report.psp.prerequisite, "met");
  assert.ok(report.facts.every((fact) => fact.evidenceRefs.every((ref) => report.evidence.some((item) => item.evidenceRef === ref))));
});

test("one observed passed shop linked to the same customer satisfies the PSP prerequisite while target and other shops stay unknown or uncontrolled", async () => {
  const observation = { ...pspFixture, final: { ...pspFixture.final, status: "uncontrolled" as const }, linkedShops: [
    { applicationRef: pspFixture.applicationRef, customerRef: pspFixture.customerRef, shopRef: "other-passed-shop", bindingRef: "other-binding",
      status: "passed" as const, eventRef: "other-shop-passed", observedAt: "2026-10-18T12:01:00.000Z" },
    { applicationRef: pspFixture.applicationRef, customerRef: pspFixture.customerRef, shopRef: "unknown-shop", bindingRef: "unknown-binding",
      status: "unknown" as const, eventRef: null, observedAt: null },
  ] };
  const mock = createMockTroubleshooting({ pspObservation: observation, completeness: "unknown" });
  await mock.receive({ input: { scenario: "psp", applicationId: observation.applicationRef, shopId: observation.target.shopRef,
    bindingId: observation.target.bindingRef, question: "Explain the target shop and PSP prerequisite." } }); await mock.closed;
  const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view); assert.equal(view.state, "completed");
  const report = (await mock.delivery.next()).report; assert.ok(report.scene === "psp");
  assert.equal(report.psp.final.status, "uncontrolled"); assert.equal(report.psp.prerequisite, "met");
  assert.equal(report.psp.approval, "unknown"); assert.equal(report.psp.amount, null);
  assert.ok(report.facts.some((fact) => fact.statement.includes("other-passed-shop") && fact.evidenceRefs.length > 0));
  assert.match(report.limitations.join(" "), /unknown|every customer shop/);
});
