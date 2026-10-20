import test from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { McpBoundary } from "../../src/adapters/mcp/boundary.js";
import { loadKibanaProfile, kibanaLogPorts } from "../../src/adapters/kibana/logs.js";
import { kibanaProfile, kibanaServer, esBody } from "../fixtures/kibana.js";
import { pspFixture } from "../fixtures/psp.js";
import type { CallContext } from "../../src/troubleshooting/application/ports.js";

export const pspNativeRows = () => [
  { eventRef: pspFixture.target.recordRef, observedAt: pspFixture.target.boundAt }, pspFixture.first, pspFixture.support, pspFixture.final,
].map((point) => ({ _id: point.eventRef!, _index: "synthetic-psp", _score: null, _source: { event_id: point.eventRef!, event_time: point.observedAt!,
  application_id: pspFixture.applicationRef, customer_id: pspFixture.customerRef, shop_id: pspFixture.target.shopRef, binding_id: pspFixture.target.bindingRef,
  verification: pspFixture } }));

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
