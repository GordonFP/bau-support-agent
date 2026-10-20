import test from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { McpBoundary } from "../../src/adapters/mcp/boundary.js";
import { loadKibanaProfile, kibanaLogPorts } from "../../src/adapters/kibana/logs.js";
import { kibanaProfile, kibanaServer, esBody } from "../fixtures/kibana.js";
import { pspFixture } from "../fixtures/psp.js";
import type { CallContext } from "../../src/troubleshooting/application/ports.js";
import type { PspObservation } from "../../src/troubleshooting/domain/psp.js";
import { Troubleshooting } from "../../src/troubleshooting/application/troubleshooting.js";
import { mockModelPolicy } from "../../src/troubleshooting/application/model-envelope.js";

export const pspNativeRows = (value: PspObservation = pspFixture) => [
  { eventRef: value.target.recordRef, observedAt: value.target.boundAt }, value.first, value.support,
  value.second.transaction, value.second.tailThree, value.final, ...value.linkedShops, ...(value.executions ?? []),
].filter((point) => point.eventRef && point.observedAt).map((point) => ({ _id: point.eventRef!, _index: "synthetic-psp", _score: null,
  _source: { event_id: point.eventRef!, event_time: point.observedAt!, application_id: value.applicationRef, customer_id: value.customerRef,
    shop_id: value.target.shopRef, binding_id: value.target.bindingRef, verification: value } }))
  .sort((a, b) => Date.parse(a._source.event_time) - Date.parse(b._source.event_time) || a._id.localeCompare(b._id));

test("B binds native PSP queries to approved application/shop/binding and preserves point facts with unknown completeness", async () => {
  const server = await kibanaServer((_body, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rawResponse: { ...esBody(), hits: { hits: pspNativeRows(), total: { value: 4, relation: "eq" } } } })));
  const artifact = await kibanaProfile(server.url, (value) => { value.index = "synthetic-psp"; }); const mock = createMockTroubleshooting({ pspObservation: pspFixture });
  const resources = ["simulator-source", "psp-log-source", "psp-code"];
  const context: CallContext = { caseRef: "case-1", phaseId: 1, callId: "psp-native", principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1",
    policyVersion: "synthetic-policy", approvalRef: "synthetic-approval", resourceRefs: resources, snapshotRef: "simulator-snapshot-1", budgetRef: "case-1", deadline: mock.ports.clock.now() + 30_000, signal: new AbortController().signal };
  try {
    const adapter = kibanaLogPorts(mock.ports, { profile: await loadKibanaProfile(artifact), sourceRef: "psp-log-source", approvedCaseResourceRefs: resources, resolveIdentifier: (_context, identifier) => identifier }, new McpBoundary(mock.ports));
    const result = await adapter.logs.read(context, { sourceRef: "psp-log-source", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef, bindingId: pspFixture.target.bindingRef,
      from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z", pageSize: 100 });
    assert.equal(result.completeness, "unknown"); assert.ok(result.value && "kind" in result.value && result.value.kind === "psp_observation");
    assert.equal(result.value.support.status, "unsupported"); assert.equal(result.evidence.length, 4);
    assert.ok(result.evidence.every((item) => item.sourceRef === "psp-log-source" && item.completeness === "unknown"));
    const body = server.requests[0]!.body.params.body as { query: { bool: { filter: unknown[] } } };
    assert.deepEqual(body.query.bool.filter.slice(0, 3), [{ term: { application_id: pspFixture.applicationRef } }, { term: { shop_id: pspFixture.target.shopRef } }, { term: { binding_id: pspFixture.target.bindingRef } }]);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC-SECRET|127\.0\.0\.1/);
  } finally { await artifact.close(); await server.close(); }
});

test("native PSP rows preserve independent support and another shop's pass before the target binding", async () => {
  const observation: PspObservation = { ...pspFixture, support: { ...pspFixture.support, observedAt: "2026-10-18T09:00:00.000Z" },
    final: { ...pspFixture.final, status: "uncontrolled" }, linkedShops: [
      { applicationRef: pspFixture.applicationRef, customerRef: pspFixture.customerRef, shopRef: "independent-shop", bindingRef: "independent-binding",
        status: "passed", eventRef: "independent-pass", observedAt: "2026-10-18T09:15:00.000Z" },
    ] };
  const rows = pspNativeRows(observation);
  const server = await kibanaServer((_body, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rawResponse: { ...esBody(), hits: { hits: rows, total: { value: rows.length, relation: "eq" } } } })));
  const artifact = await kibanaProfile(server.url, (value) => { value.index = "synthetic-psp"; });
  const resources = ["simulator-source", "psp-log-source", "psp-code"];
  const mock = createMockTroubleshooting({ pspObservation: observation, resourceRefs: resources });
  try {
    Object.assign(mock.ports, kibanaLogPorts(mock.ports, { profile: await loadKibanaProfile(artifact), sourceRef: "psp-log-source",
      approvedCaseResourceRefs: resources, resolveIdentifier: (_context, identifier) => identifier }, new McpBoundary(mock.ports)));
    const application = new Troubleshooting(mock.ports, { mode: "mock", modelPolicy: mockModelPolicy, resourceRefs: resources, snapshotRef: "simulator-snapshot-1",
      psp: { sourceRef: "psp-log-source", repositoryRef: "psp-code" }, queryWindow: { from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z" } });
    await application.accept({ ...mock.inbound, input: { scenario: "psp", applicationId: observation.applicationRef, shopId: observation.target.shopRef,
      bindingId: observation.target.bindingRef, question: "Keep independent observation times." } }); await mock.closed;
    const view = await application.get(mock.inbound, "case-1"); assert.ok("state" in view); assert.equal(view.state, "completed", JSON.stringify(view));
    const report = (await mock.delivery.next()).report; assert.ok(report.scene === "psp");
    assert.equal(report.psp.support.status, "unsupported"); assert.equal(report.psp.prerequisite, "met");
    assert.equal(report.facts.find((fact) => fact.statement.startsWith("At least one"))!.observedAt, "2026-10-18T09:15:00.000Z");
    assert.ok(report.evidence.every((item) => item.kind !== "log" || item.completeness === "unknown"));
  } finally { await artifact.close(); await server.close(); }
});
