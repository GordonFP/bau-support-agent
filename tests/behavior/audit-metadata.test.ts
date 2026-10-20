import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import type { AuditDetails } from "../../src/troubleshooting/application/records.js";
import type { CallContext } from "../../src/troubleshooting/application/ports.js";

const context: CallContext = { caseRef: "case-1", phaseId: 1, callId: "version-audit", principalRef: "principal-1", tenantRef: "tenant-1",
  destinationRef: "private-conversation-1", resourceRefs: ["simulator-source"], snapshotRef: "simulator-snapshot-1",
  policyVersion: "mock-policy-1", approvalRef: "synthetic-approval-1", budgetRef: "case-1", deadline: 30_000, signal: new AbortController().signal };

test("C retains only closed versioned tool and model metadata tied to the host call", async () => {
  const mock = createMockTroubleshooting();
  await mock.receive(); await mock.delivery.next(); await mock.closed;
  const tool: AuditDetails = { tool: { name: "read_logs", schemaVersion: "synthetic-evidence-1", artifactVersion: "synthetic-local-service-1",
    manifestSha256: "a".repeat(64), sanitizationVersion: "host-reviewed-sanitization-1" } };
  const model: AuditDetails = { model: { profile: "local_protocol", protocol: "synthetic-responses-byte-pairs-1", schemaVersion: "model-turn-1", artifactVersion: "pi-ai-1.3.0" } };
  await mock.ports.audit.intent(context, "synthetic-tool", tool);
  await mock.ports.audit.complete({ ...context, callId: "model-version-audit" }, "model.generate", "ok", model);
  const records = await mock.ports.records.export(mock.inbound, "case-1");
  assert.ok(records);
  assert.equal(records.audits.find((audit) => audit.action === "synthetic-tool")?.manifestSha256, "a".repeat(64));
  assert.deepEqual(records.audits.find((audit) => audit.callId === "model-version-audit")?.model, model.model);
  await assert.rejects(mock.ports.audit.intent(context, "synthetic-tool", { tool: { ...tool.tool!, manifestSha256: "invalid" } }), /invalid_request/);
  await assert.rejects(mock.ports.audit.intent(context, "model.generate", { model: { ...model.model!, profile: "memory_mock" } }), /invalid_request/);
  await assert.rejects(mock.ports.audit.intent(context, "model.generate", { model: { ...model.model!, endpoint: "forbidden" } } as AuditDetails), /invalid_request/);
});
