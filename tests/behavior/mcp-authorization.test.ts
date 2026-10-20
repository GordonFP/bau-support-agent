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

type Profile = "kibana" | "synthetic_logs" | "synthetic_code";
async function postcall(profileName: Profile, persistence: "mock" | "sqlite", mode: "foreign" | "revoked" | "audit_failure", verify: (result: {
  mock: ReturnType<typeof createMockTroubleshooting>; pending: Promise<unknown>; physicalCalls(): Promise<number>;
  action: string; auditCalls: string[];
}) => Promise<void>) {
  const { SqliteRecords } = await import("../../src/adapters/records/sqlite.js");
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { logRow, esBody } = await import("../fixtures/kibana.js");
  const directory = await mkdtemp(join(tmpdir(), "bau-mcp-postcall-")), receipt = join(directory, "source-calls");
  let store: InstanceType<typeof SqliteRecords> | undefined;
  const mock = createMockTroubleshooting({ controlPorts: (ports) => {
    if (persistence === "mock") return {};
    store = new SqliteRecords(directory, ports);
    return { admission: store.admission, records: store.records, audit: store.audit, budget: store.budget };
  } });
  const server = await kibanaServer((_body, response) => {
    const row = logRow(); if (mode !== "revoked") row._source.application_id = "foreign-application";
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rawResponse: esBody([row]) }));
  }), artifact = await kibanaProfile(server.url);
  try {
    await mock.receive(); await mock.closed;
    const action = profileName === "synthetic_code" ? "mcp.code.search" : "mcp.logs.read";
    const auditCalls: string[] = [];
    const intent = mock.ports.audit.intent, complete = mock.ports.audit.complete, allows = mock.ports.authorization.allows;
    let revoked = false;
    mock.ports.authorization.allows = (operation, actor) => operation === action && revoked ? Promise.resolve(false) : allows(operation, actor);
    mock.ports.audit.intent = async (...args) => { auditCalls.push(`${args[1]}:intent`); return intent(...args); };
    mock.ports.audit.complete = async (...args) => {
      auditCalls.push(`${args[1]}:complete:${args[2]}`);
      if (mode === "audit_failure" && args[1] === action) throw new Error("synthetic-audit-failure");
      await complete(...args);
      if (mode === "revoked" && args[1] === action && args[2] === "ok") revoked = true;
    };
    const ctx = { ...context, callId: "postcall", operationRef: "case-1:original-postcall" };
    let pending: Promise<unknown>;
    if (profileName === "kibana") {
      const adapter = kibanaLogPorts(mock.ports, { profile: await loadKibanaProfile(artifact), resolveIdentifier }, new McpBoundary(mock.ports));
      pending = adapter.logs.read(ctx, query);
    } else {
      const fixtureMode = mode === "revoked" ? "normal" : profileName === "synthetic_code" ? "cross_repository" : "foreign_target";
      const source = { ...endpoint, args: [service, fixtureMode, receipt] };
      const adapter = mcpEvidencePorts(mock.ports, { logs: source, code: source, resolveIdentifier });
      pending = profileName === "synthetic_code" ? adapter.code.search(ctx, { repositoryRef: "simulator-source", snapshotRef: context.snapshotRef }) : adapter.logs.read(ctx, query);
    }
    await verify({ mock, pending, action, auditCalls, physicalCalls: async () => profileName === "kibana" ? server.requests.length
      : (await readFile(receipt, "utf8")).split("\n").filter((line) => line === (profileName === "synthetic_code" ? "search_code" : "read_logs")).length });
  } finally { store?.close(); await artifact.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
}

for (const profileName of ["kibana", "synthetic_logs", "synthetic_code"] as const) {
  for (const persistence of ["mock", "sqlite"] as const) test(`${profileName} post-call refusal completes the original intent and exports a denied decision through C ${persistence}`, async () => {
    await postcall(profileName, persistence, "foreign", async ({ mock, pending, action, physicalCalls }) => {
      const before = mock.events.filter((event) => ["model.generate", "delivery.send"].includes(event.action)).length;
      await assert.rejects(pending, /^Error: denied$/); assert.equal(await physicalCalls(), 1);
      const retained = await mock.ports.records.export(mock.inbound, "case-1"); assert.ok(retained?.scope === "full");
      const original = retained.audits.filter((row) => row.action === action && row.callId === "postcall");
      assert.deepEqual(original.map((row) => [row.stage, row.outcome]), [["intent", "pending"], ["complete", "denied"]]);
      assert.ok(original.every((row) => row.operationId === "case-1:original-postcall"));
      assert.deepEqual(original[0]!.authorization, { decision: "allowed", reason: "policy_allowed" });
      const denial = retained.audits.find((row) => row.action === "authorization.denied" && row.stage === "complete");
      assert.ok(denial); assert.deepEqual(denial.authorization, { decision: "denied", reason: "denied" });
      assert.equal(mock.events.filter((event) => ["model.generate", "delivery.send"].includes(event.action)).length, before);
      assert.doesNotMatch(JSON.stringify(retained), /foreign-application|SYNTHETIC-SECRET|127\.0\.0\.1/);
    });
  });

  test(`${profileName} late authorization refusal preserves its completed original result without a second completion`, async () => {
    await postcall(profileName, "sqlite", "revoked", async ({ mock, pending, action, physicalCalls }) => {
      await assert.rejects(pending, /^Error: denied$/); assert.equal(await physicalCalls(), 1);
      const retained = await mock.ports.records.export(mock.inbound, "case-1"); assert.ok(retained?.scope === "full");
      const original = retained.audits.filter((row) => row.action === action && row.callId === "postcall");
      assert.deepEqual(original.map((row) => [row.stage, row.outcome, row.operationId]), [
        ["intent", "pending", "case-1:original-postcall"], ["complete", "ok", "case-1:original-postcall"],
      ]);
      assert.ok(retained.audits.some((row) => row.action === "authorization.denied" && row.stage === "complete" &&
        (row.authorization as { decision: string }).decision === "denied"));
    });
  });

  test(`${profileName} post-call result audit failure stops before a denial audit or retry`, async () => {
    await postcall(profileName, "sqlite", "audit_failure", async ({ mock, pending, action, physicalCalls, auditCalls }) => {
      await assert.rejects(pending, /^Error: audit_unavailable$/); assert.equal(await physicalCalls(), 1);
      const sourceCalls = auditCalls.filter((call) => !call.startsWith("records."));
      assert.deepEqual(sourceCalls, [`${action}:intent`, `${action}:complete:denied`]);
      const retained = await mock.ports.records.export(mock.inbound, "case-1"); assert.ok(retained?.scope === "full");
      assert.equal(retained.audits.some((row) => row.action === "authorization.denied"), false);
    });
  });
}
