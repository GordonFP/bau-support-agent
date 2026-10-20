import { test } from "node:test";
import assert from "node:assert/strict";
import { postmanKibana } from "../fixtures/postman-kibana.js";
import { kibanaProfile } from "../fixtures/kibana.js";
import { kibanaLogPorts, loadKibanaProfile } from "../../src/adapters/kibana/logs.js";
import { McpBoundary } from "../../src/adapters/mcp/boundary.js";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";

test("actual log adapter and native artifact use the reviewed Postman local HTTP subset", async () => {
  assert.ok(process.env.POSTMAN_CLI, "Set POSTMAN_CLI to the reviewed local CLI executable.");
  const simulation = await postmanKibana(process.env.POSTMAN_CLI); const artifact = await kibanaProfile(simulation.baseUrl);
  const mock = createMockTroubleshooting();
  try {
    const profile = await loadKibanaProfile(artifact), adapter = kibanaLogPorts(mock.ports, { profile, resolveIdentifier: (_context, id) => id }, new McpBoundary(mock.ports));
    const result = await adapter.logs.read({ caseRef: "case-1", phaseId: 1, callId: "logs-1", principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1",
      approvalRef: "approved", policyVersion: "poc-1", resourceRefs: ["simulator-source"], snapshotRef: "simulator-snapshot-1", budgetRef: "case-1", deadline: mock.ports.clock.now() + 30_000, signal: new AbortController().signal },
    { sourceRef: "simulator-source", applicationId: "SYNTHETIC-SECRET-APPLICATION", from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z", pageSize: 100 });
    assert.equal(result.completeness, "unknown"); assert.equal(result.evidence.length, 1); assert.match(result.warnings.join(" "), /unknown/);
    await simulation.waitForRequests(1); assert.equal(simulation.requests().length, 1);
    assert.equal((await fetch(simulation.baseUrl + "/unmodeled")).status, 501);
    assert.equal((await fetch(simulation.baseUrl + "/internal/search/es", { method: "POST", headers: { "content-type": "application/json" }, body: '{"params":{"index":"unapproved","body":{}}}' })).status, 400);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC-SECRET|127\.0\.0\.1/);
  } finally { await artifact.close(); await simulation.close(); }
});
