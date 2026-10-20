import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { mcpEvidencePorts } from "../../src/adapters/mcp/evidence.js";
import { McpBoundary } from "../../src/adapters/mcp/boundary.js";
import { syntheticManifest } from "../../src/adapters/mcp/manifest.js";
import { kibanaLogPorts, loadKibanaProfile } from "../../src/adapters/kibana/logs.js";
import { kibanaProfile, kibanaServer } from "../fixtures/kibana.js";
import type { CallContext, LogQuery } from "../../src/troubleshooting/application/ports.js";

const service = fileURLToPath(new URL("../fixtures/mcp-service.js", import.meta.url));
const endpoint = { command: process.execPath, args: [service, "normal"], artifact: { path: service,
  sha256: createHash("sha256").update(readFileSync(service)).digest("hex") }, manifest: syntheticManifest };
const query: LogQuery = { sourceRef: "simulator-source", applicationId: "SYNTHETIC-SECRET-APPLICATION", from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z", pageSize: 100 };
const context: CallContext = { caseRef: "case-1", phaseId: 1, callId: "refused", principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1",
  policyVersion: "mock-policy-1", approvalRef: "approved", resourceRefs: ["simulator-source"], snapshotRef: "simulator-snapshot-1", budgetRef: "case-1", deadline: 30000, signal: new AbortController().signal };
const resolveIdentifier = (_context: CallContext, id: string) => id;

for (const stage of ["intent", "complete"] as const) test(`log and code denials fail closed when their ${stage} audit cannot be persisted`, async () => {
  const mock = createMockTroubleshooting({ denyActions: ["mcp.logs.read", "mcp.code.search"], auditFails: `authorization.denied:${stage}` });
  const server = await kibanaServer(), artifact = await kibanaProfile(server.url);
  const attempts = { intent: 0, complete: 0 };
  const intent = mock.ports.audit.intent, complete = mock.ports.audit.complete;
  mock.ports.audit.intent = async (...args) => { if (args[1] === "authorization.denied") attempts.intent++; return intent(...args); };
  mock.ports.audit.complete = async (...args) => { if (args[1] === "authorization.denied") attempts.complete++; return complete(...args); };
  try {
    const native = kibanaLogPorts(mock.ports, { profile: await loadKibanaProfile(artifact), resolveIdentifier }, new McpBoundary(mock.ports));
    const synthetic = mcpEvidencePorts(mock.ports, { logs: endpoint, code: endpoint, resolveIdentifier });
    for (const read of [() => native.logs.read(context, query), () => synthetic.logs.read(context, query), () => synthetic.code.search(context, { repositoryRef: "simulator-source", snapshotRef: context.snapshotRef })]) {
      await assert.rejects(read(), /^Error: audit_unavailable$/);
    }
    assert.deepEqual(attempts, { intent: 3, complete: stage === "complete" ? 3 : 0 });
    assert.equal(server.requests.length, 0);
    assert.equal(mock.events.some((event) => ["model.generate", "delivery.send", "audit:mcp.logs.read:complete", "audit:mcp.code.search:complete"].includes(event.action)), false);
  } finally { await artifact.close(); await server.close(); }
});

for (const profileName of ["kibana", "synthetic"] as const) test(`${profileName} B constructor shares the 64-character host alias boundary and captures its original approved set`, async () => {
  const server = await kibanaServer(), artifact = await kibanaProfile(server.url), mock = createMockTroubleshooting();
  try {
    const profile = await loadKibanaProfile(artifact);
    const create = (approvedCaseResourceRefs: readonly string[]) => profileName === "kibana"
      ? kibanaLogPorts(mock.ports, { profile, resolveIdentifier, approvedCaseResourceRefs }, new McpBoundary(mock.ports))
      : mcpEvidencePorts(mock.ports, { logs: endpoint, code: endpoint, resolveIdentifier, approvedCaseResourceRefs });
    assert.doesNotThrow(() => create(["simulator-source", "a".repeat(64)]));
    assert.throws(() => create(["simulator-source", "a".repeat(65)]), /^Error: contract_unverified$/);
    const approved = ["payments-source", "simulator-source"], adapter = create(approved);
    approved.push("unapproved-source");
    const original = { ...context, resourceRefs: ["simulator-source", "payments-source"] };
    assert.equal((await adapter.logs.read(original, query)).evidence.length, 1);
    const requests = server.requests.length;
    await assert.rejects(adapter.logs.read({ ...original, resourceRefs: approved }, query), /^Error: denied$/);
    assert.equal(server.requests.length, requests);
  } finally { await artifact.close(); await server.close(); }
});
