import test from "node:test";
import assert from "node:assert/strict";
import { postmanResponses } from "../fixtures/postman-responses.js";
import { postmanTeams } from "../fixtures/postman-teams.js";
import { postmanKibana } from "../fixtures/postman-kibana.js";
import { nativeTroubleshooting } from "../fixtures/pi-runtime.js";
import { teamsServices } from "../fixtures/teams.js";
import { pspFixture } from "../fixtures/psp.js";
import { kibanaProfile } from "../fixtures/kibana.js";
import { createLocalTeamsHost } from "../../src/adapters/teams/host.js";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { kibanaLogPorts, loadKibanaProfile } from "../../src/adapters/kibana/logs.js";
import { McpBoundary } from "../../src/adapters/mcp/boundary.js";

test("actual PSP Pi/MCP and signed Teams use the reviewed Postman Responses selection and Connector contracts", { timeout: 30_000 }, async () => {
  assert.ok(process.env.POSTMAN_CLI);
  const model = await postmanResponses(process.env.POSTMAN_CLI), connector = await postmanTeams(process.env.POSTMAN_CLI), service = await teamsServices();
  const { mock, pi } = await nativeTroubleshooting(model.baseUrl, { pspObservation: pspFixture }, "psp:unsupported");
  const host = await createLocalTeamsHost({ ...service.configuration, serviceUrl: connector.baseUrl }, { application: mock.application, ports: mock.ports });
  try {
    await host.start();
    const response = await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken(false, { serviceurl: connector.baseUrl })}` },
      body: JSON.stringify({ ...service.activity(JSON.stringify({ action: "investigate", scenario: "psp", applicationId: pspFixture.applicationRef,
        shopId: pspFixture.target.shopRef, bindingId: pspFixture.target.bindingRef, question: "Explain PSP." })), serviceUrl: connector.baseUrl }) });
    assert.equal((await response.json() as { status: string }).status, "accepted"); await mock.closed;
    const saved = await mock.ports.records.read(service.mapping.actor, "case-1"); assert.ok(saved?.scope === "full"); assert.equal(saved.view.state, "completed", JSON.stringify(saved.view));
    const output = saved.records.findLast((item) => item.kind === "model_output")!.payload as { candidate: { reportRef: string; draftVersion: string } };
    assert.deepEqual(Object.keys(output.candidate).sort(), ["draftVersion", "reportRef"]);
    await model.waitForRequests(3); await connector.waitForRequests(2);
    assert.ok(model.requests().every((request) => request.statusCode === 200)); assert.ok(connector.requests().every((request) => request.statusCode === 200));
    assert.doesNotMatch(JSON.stringify({ saved, model: model.logs(), connector: connector.logs() }), /SYNTHETIC-SECRET|Bearer /);
  } finally { await host.stop(); await pi.close("case-1"); await service.close(); await connector.close(); await model.close(); }
});

test("actual native log client confines PSP association filters through the owned Postman ES subset", { timeout: 20_000 }, async () => {
  assert.ok(process.env.POSTMAN_CLI);
  const simulation = await postmanKibana(process.env.POSTMAN_CLI), artifact = await kibanaProfile(simulation.baseUrl, (value) => { value.index = "synthetic-psp"; });
  const mock = createMockTroubleshooting({ pspObservation: pspFixture }), resources = ["simulator-source", "psp-log-source", "psp-code"];
  try {
    const adapter = kibanaLogPorts(mock.ports, { profile: await loadKibanaProfile(artifact), sourceRef: "psp-log-source", approvedCaseResourceRefs: resources, resolveIdentifier: (_context, id) => id }, new McpBoundary(mock.ports));
    const result = await adapter.logs.read({ caseRef: "case-1", phaseId: 1, callId: "psp-contract", principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1",
      policyVersion: "synthetic-policy", approvalRef: "synthetic-approval", resourceRefs: resources, snapshotRef: "simulator-snapshot-1", budgetRef: "case-1", deadline: mock.ports.clock.now() + 30_000, signal: new AbortController().signal },
      { sourceRef: "psp-log-source", applicationId: pspFixture.applicationRef, shopId: pspFixture.target.shopRef, bindingId: pspFixture.target.bindingRef, from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z", pageSize: 100 });
    assert.ok(result.value && "kind" in result.value && result.value.kind === "psp_observation"); assert.equal(result.value.support.status, "unsupported");
    assert.equal(result.completeness, "unknown"); assert.equal(result.evidence.length, 4);
    await simulation.waitForRequests(1); assert.equal(simulation.requests()[0]!.statusCode, 200);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC-SECRET|127\.0\.0\.1/);
    // The owned backend wire fixture deliberately contains raw synthetic IDs;
    // only the adapter's sanitized boundary result may reach C/model/D.
    assert.match(simulation.logs().stdout, /SYNTHETIC-SECRET/);
  } finally { await artifact.close(); await simulation.close(); }
});
