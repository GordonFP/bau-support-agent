import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { mcpEvidencePorts } from "../../src/adapters/mcp/evidence.js";
import { syntheticManifest, digest } from "../../src/adapters/mcp/manifest.js";
import type { CallContext, LogQuery } from "../../src/troubleshooting/application/ports.js";
import { ManualClock } from "../fixtures/clock.js";

const service = fileURLToPath(new URL("../fixtures/mcp-service.js", import.meta.url));
const endpoint = (mode = "normal") => ({ command: process.execPath, args: [service, mode],
  artifact: { path: service, sha256: createHash("sha256").update(readFileSync(service)).digest("hex") }, manifest: syntheticManifest });
function setup(mode = "normal", options: Parameters<typeof createMockTroubleshooting>[0] = {}) {
  const mock = createMockTroubleshooting({ ...options, controlPorts: (ports) => ({ records: ports.records, ...mcpEvidencePorts(ports, {
    logs: endpoint(mode), code: endpoint(mode),
    resolveIdentifier: (context, value) => {
      if (!["case-1", "case-2"].includes(context.caseRef) || !["SYNTHETIC-SECRET-APPLICATION", "SYNTHETIC-SECRET-CUSTOMER"].includes(value)) throw new Error("denied");
      return value;
    },
  }) }) });
  return mock;
}

test("independent MCP client and local synthetic services produce the complete Simulator report", async () => {
  const mock = setup();
  assert.equal((await mock.receive()).status, "accepted");
  const { report } = await mock.delivery.next();
  assert.ok(report.scene === "simulator");
  assert.deepEqual(report.simulator.dataReadiness, { satisfied: 9, missing: 1, unknown: 0 });
  assert.equal(report.evidence.length, 2);
  assert.ok(report.evidence.every((item) => item.text.startsWith("[untrusted MCP evidence]")));
  const records = await mock.ports.records.export(mock.inbound, "case-1");
  assert.ok(records);
  assert.doesNotMatch(JSON.stringify(records), /SYNTHETIC-SECRET/);
  const toolAudit = records.audits.find((audit) => audit.action === "mcp.logs.read" && audit.stage === "complete");
  assert.ok(toolAudit);
  assert.equal(toolAudit.toolSchemaVersion, "synthetic-evidence-1");
  assert.equal(toolAudit.artifactVersion, "synthetic-local-service-1");
  assert.equal(toolAudit.manifestSha256, digest(syntheticManifest));
  assert.equal(toolAudit.sanitizationVersion, "host-reviewed-sanitization-1");
});

for (const invalidDate of ["2026-99-99", "2026-04-31", "2026-02-29", "1900-02-29"]) {
  test(`native MCP rejects nonexistent calendar date ${invalidDate} before model, evidence retention or report delivery`, async () => {
    for (const field of ["submittedOn", "completeThrough"]) {
      const mock = setup(`calendar:${field}:${invalidDate}`);
      await mock.receive(); await mock.closed;
      const state = await mock.application.get(mock.inbound, "case-1");
      assert.ok("state" in state);
      assert.equal(state.state, "stopped");
      assert.equal(state.stopReason, "schema_mismatch");
      assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send"), false);
      const records = await mock.ports.records.export(mock.inbound, "case-1");
      assert.ok(records);
      assert.equal(records.records.some((record) => ["evidence", "tool_result", "model_input", "report"].includes(record.kind)), false);
      assert.equal(JSON.stringify(records).includes(invalidDate), false);
    }
  });
}

for (const validDate of ["2024-02-29", "2000-02-29"]) {
  test(`native MCP preserves valid Gregorian leap day ${validDate} through the complete report`, async () => {
    const mock = setup(`calendar:all:${validDate}`);
    await mock.receive();
    const { report } = await mock.delivery.next();
    assert.ok(report.scene === "simulator");
    assert.equal(report.simulator.submittedOn, validDate);
    assert.deepEqual(report.simulator.dataReadiness, { satisfied: 10, missing: 0, unknown: 0 });
    assert.ok(report.simulator.shops.every((shop) => shop.targetDate === validDate && shop.completeThrough === validDate));
  });
}

test("native MCP null coverage remains unknown rather than becoming a calendar or readiness success", async () => {
  const mock = setup("null_coverage");
  await mock.receive();
  const { report } = await mock.delivery.next();
  assert.ok(report.scene === "simulator");
  assert.deepEqual(report.simulator.dataReadiness, { satisfied: 0, missing: 0, unknown: 10 });
  assert.ok(report.simulator.shops.every((shop) => shop.completeThrough === null && shop.readiness === "unknown"));
});

test("native MCP evidence and candidate datetimes also reject nonexistent calendar dates", async () => {
  for (const field of ["observedAt", "acquiredAt", "indexedAt", "candidateSubmittedAt"]) {
    const mock = setup(`calendar:${field}:2026-02-29`);
    const read = field === "indexedAt" ? mock.ports.code.search(context(), { repositoryRef: "simulator-source", snapshotRef: "simulator-snapshot-1" })
      : mock.ports.logs.read(context(), field === "candidateSubmittedAt" ? { sourceRef: "simulator-source", customerId: "SYNTHETIC-SECRET-CUSTOMER",
        from: query.from, to: query.to, pageSize: 100 } : query);
    await assert.rejects(read, /^Error: schema_mismatch$/);
    assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send"), false);
  }
});

test("nonexistent query-window dates are rejected before the independent source process starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-mcp-calendar-"));
  const receipt = join(directory, "operations");
  try {
    const mock = createMockTroubleshooting();
    const endpointConfig = { ...endpoint(), args: [service, "normal", receipt] };
    const configured = mcpEvidencePorts(mock.ports, { logs: endpointConfig, code: endpointConfig, resolveIdentifier: (_ctx, value) => value });
    for (const invalid of [ { ...query, from: "2026-02-29T00:00:00.000Z", to: "2026-03-02T00:00:00.000Z" },
      { ...query, from: "2026-02-28T00:00:00.000Z", to: "2026-02-29T00:00:00.000Z" } ]) {
      await assert.rejects(configured.logs.read(context(), invalid), /^Error: invalid_request$/);
      await assert.rejects(readFile(receipt), { code: "ENOENT" });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("progress does not extend the absolute deadline; cancellation closes only its owned case connection", { timeout: 5000 }, async () => {
  const start = performance.now();
  const clock = { now: () => performance.now() - start, utc: () => "2026-10-19T09:00:00.000Z" };
  const mock = setup("heartbeat", { clock });
  await assert.rejects(mock.ports.logs.read(context({ deadline: 250 }), query), /timeout/);
  assert.ok(performance.now() - start < 1500);
  const abort = new AbortController();
  const pending = mock.ports.logs.read(context({ deadline: 30_000, signal: abort.signal, callId: "cancelled-call" }), query);
  const healthy = setup();
  const other = healthy.ports.logs.read(context(), query);
  setTimeout(() => abort.abort(), 150);
  await assert.rejects(pending, /cancelled/);
  assert.equal((await other).evidence.length, 1);
});

test("cancellation during child reaping still refuses the result and leaves another case on the same Adapter usable", async () => {
  const mock = setup();
  const audited = Promise.withResolvers<void>();
  const complete = mock.ports.audit.complete;
  mock.ports.audit.complete = async (ctx, action, outcome, details) => {
    await complete(ctx, action, outcome, details);
    if (ctx.caseRef === "case-1" && action === "mcp.logs.read" && outcome === "ok") audited.resolve();
  };
  const stop = new AbortController();
  const pending = mock.ports.logs.read(context({ signal: stop.signal }), query);
  const other = mock.ports.logs.read(context({ caseRef: "case-2", callId: "other-case" }), query);
  await audited.promise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal((await other).evidence[0]!.targetRef, "[case-2:application]");
});

for (const stage of ["intent", "complete"] as const) {
  test(`an inner MCP ${stage} audit failure latches one fixed fault and stops all subsequent disclosure`, async () => {
    const mock = setup("normal", { auditFails: `mcp.logs.read:${stage}` });
    await mock.receive();
    await mock.closed;
    await new Promise(setImmediate);
    assert.equal(mock.events.filter((event) => event.action === "delivery.fault").length, 1);
    assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send" || event.action === "audit:mcp.code.search:intent"), false);
    assert.equal(mock.events.filter((event) => event.action === "audit:mcp.logs.read:complete").length, 0);
  });
}

test("current authorization is rechecked after results and every new call", async () => {
  const mock = setup();
  const original = mock.ports.authorization.allows;
  let checks = 0;
  mock.ports.authorization.allows = async (action, ctx) => {
    if (action === "mcp.logs.read" && ++checks >= 4) return false;
    return original(action, ctx);
  };
  await assert.rejects(mock.ports.logs.read(context(), query), /denied/);
  await assert.rejects(mock.ports.logs.read(context({ callId: "call-2" }), query), /denied/);
  assert.equal(mock.events.some((event) => event.action === "model.generate"), false);
});

test("the independent local service observes zero denied/audit-failed starts and exactly one authorized tool call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-mcp-receipt-"));
  const receipt = join(directory, "operations");
  try {
    for (const options of [{ denyActions: ["mcp.logs.read"] }, { auditFails: "mcp.logs.read:intent" }, {}]) {
      const mock = createMockTroubleshooting(options);
      const endpointConfig = { ...endpoint(), args: [service, "normal", receipt] };
      const configured = mcpEvidencePorts(mock.ports, { logs: endpointConfig, code: endpointConfig, resolveIdentifier: (_ctx, value) => value });
      if ("denyActions" in options || "auditFails" in options) {
        await assert.rejects(configured.logs.read(context(), query), /(denied|audit_unavailable)/);
        await assert.rejects(readFile(receipt), { code: "ENOENT" });
      } else {
        await configured.logs.read(context(), query);
        assert.deepEqual((await readFile(receipt, "utf8")).trim().split("\n"), ["started", "tools/list", "read_logs"]);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an overlapping call cannot release an existing case lease; an old phase cannot return after a new one", async () => {
  const mock = setup("heartbeat");
  const stop = new AbortController();
  const pending = mock.ports.logs.read(context({ signal: stop.signal }), query);
  // The first authorization await establishes the bounded case lease.
  await new Promise(setImmediate);
  await assert.rejects(mock.ports.logs.read(context({ callId: "overlap-1" }), query), /unavailable/);
  await assert.rejects(mock.ports.logs.read(context({ callId: "overlap-2" }), query), /unavailable/);
  const next = mock.ports.code.search(context({ callId: "new-phase", phaseId: 2 }), { repositoryRef: "simulator-source", snapshotRef: "simulator-snapshot-1" });
  setTimeout(() => stop.abort(), 150);
  await assert.rejects(pending, /(cancelled|timeout)/);
  // The synthetic next phase uses heartbeat too, so cancel it through its own signal.
  mock.ports.sanitization.clear("case-1");
  await assert.rejects(next, /cancelled/);
});

test("changed local artifacts and malformed audit version metadata fail closed", async () => {
  const mock = createMockTroubleshooting();
  const configured = endpoint();
  const ports = mcpEvidencePorts(mock.ports, { logs: { ...configured, artifact: { ...configured.artifact, sha256: "0".repeat(64) } }, code: configured,
    resolveIdentifier: (_context, value) => value });
  await assert.rejects(ports.logs.read(context(), query), /contract_unverified/);
  await assert.rejects(mock.ports.audit.intent(context(), "synthetic", { tool: { name: "read_logs", schemaVersion: "unsafe version",
    artifactVersion: "synthetic-local-service-1", manifestSha256: digest(syntheticManifest), sanitizationVersion: "host-reviewed-sanitization-1" } }), /invalid_request/);
});

test("same-case aliases are stable across native endpoints while another case gets unlinkable aliases", async () => {
  const mock = setup();
  const first = await mock.ports.logs.read(context(), query);
  const repeat = await mock.ports.logs.read(context({ callId: "repeat" }), query);
  const second = await mock.ports.logs.read(context({ caseRef: "case-2", callId: "other" }), query);
  assert.equal(first.evidence[0]!.targetRef, "[case-1:application]");
  assert.equal(repeat.evidence[0]!.targetRef, first.evidence[0]!.targetRef);
  assert.equal(second.evidence[0]!.targetRef, "[case-2:application]");
  assert.doesNotMatch(JSON.stringify([first, repeat, second]), /SYNTHETIC-SECRET/);
  mock.ports.sanitization.clear("case-1");
  assert.equal((await mock.ports.logs.read(context({ caseRef: "case-2", callId: "unaffected" }), query)).evidence[0]!.targetRef, "[case-2:application]");
});

test("source partial, truncation and warning information survives conversion into report evidence and limitations", async () => {
  const mock = setup("partial");
  await mock.receive();
  const { report } = await mock.delivery.next();
  assert.ok(report.evidence.every((item) => item.completeness === "partial" && item.truncated));
  assert.match(report.limitations.join(" "), /synthetic source was truncated/);
});

test("accepted MCP fragments still pass the complete model-input gate before any model attempt", async () => {
  const mock = setup("large_page");
  await mock.receive();
  await mock.closed;
  assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send"), false);
  const state = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in state);
  assert.equal(state.state, "stopped");
});

test("native customer candidates resume through same-case aliases without exposing or losing source identifiers", async () => {
  const mock = setup("candidates");
  await mock.receive({ input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why is this customer's application waiting?" } });
  await mock.phaseClosed(1);
  const state = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in state);
  assert.equal(state.state, "awaiting_input");
  assert.ok(state.question);
  const resumed = await mock.application.provideInformation({ ...mock.inbound, eventRef: "reply-1", reply: { caseRef: "case-1", questionId: state.question.questionId },
    content: { submittedAt: "2026-10-18T15:00:00.000Z" } });
  assert.equal(resumed.status, "resumed");
  await mock.phaseClosed(2);
  const final = await mock.application.get(mock.inbound, "case-1");
  assert.ok("state" in final);
  assert.equal(final.state, "completed");
  const { report } = await mock.delivery.next();
  assert.equal(report.targetSummary, "[case-1:application]-SECOND");
  const records = await mock.ports.records.export(mock.inbound, "case-1");
  assert.doesNotMatch(JSON.stringify(records), /SYNTHETIC-SECRET/);
});

test("learned source aliases reject foreign cases, revoked calls and terminal reuse", async () => {
  const mock = setup("candidates");
  await mock.ports.logs.read(context(), { ...query, applicationId: undefined, customerId: "SYNTHETIC-SECRET-CUSTOMER" } as unknown as LogQuery);
  const selected = { ...query, applicationId: "[case-1:application]-SECOND" };
  await assert.rejects(mock.ports.logs.read(context({ caseRef: "case-2", callId: "foreign" }), selected), /denied/);
  const allows = mock.ports.authorization.allows;
  mock.ports.authorization.allows = async () => false;
  await assert.rejects(mock.ports.logs.read(context({ callId: "revoked" }), selected), /denied/);
  mock.ports.authorization.allows = allows;
  mock.ports.sanitization.clear("case-1");
  await assert.rejects(mock.ports.logs.read(context({ callId: "ended" }), selected), /denied/);
});

test("a cancelled result-audit continuation cannot later publish source alias bindings", async () => {
  const mock = setup("candidates");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const complete = mock.ports.audit.complete;
  mock.ports.audit.complete = async (ctx, action, outcome, details) => {
    if (action === "mcp.logs.read" && outcome === "ok") { started.resolve(); await release.promise; }
    return complete(ctx, action, outcome, details);
  };
  const pending = mock.ports.logs.read(context(), { sourceRef: "simulator-source", customerId: "SYNTHETIC-SECRET-CUSTOMER", from: query.from, to: query.to, pageSize: 100 });
  await started.promise;
  mock.ports.sanitization.clear("case-1");
  release.resolve();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(mock.ports.logs.read(context({ callId: "late-alias" }), { ...query, applicationId: "[case-1:application]-SECOND" }), /denied/);
});

test("a late protocol fatal during result auditing is rejected before ingestion", async () => {
  const mock = setup("late_tail");
  const auditStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const complete = mock.ports.audit.complete;
  let held = false;
  mock.ports.audit.complete = async (ctx, action, outcome, details) => {
    if (!held && action === "mcp.logs.read" && outcome === "ok") { held = true; auditStarted.resolve(); await release.promise; }
    return complete(ctx, action, outcome, details);
  };
  const pending = mock.ports.logs.read(context(), query);
  await auditStarted.promise;
  await new Promise((resolve) => setTimeout(resolve, 50));
  release.resolve();
  await assert.rejects(pending, /schema_mismatch/);
  assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send"), false);
});

test("retention stays partial until an original MCP audit continuation and owned child cleanup actually finish", { timeout: 5000 }, async () => {
  const clock = new ManualClock();
  const actor = { principalRef: "lifecycle-owner", tenantRef: "tenant-1", destinationRef: "lifecycle-path" };
  const mock = setup("normal", { clock, lifecycleActors: [actor] });
  const auditStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const complete = mock.ports.audit.complete;
  mock.ports.audit.complete = async (ctx, action, outcome, details) => {
    if (action === "mcp.logs.read" && outcome === "ok") { auditStarted.resolve(); await release.promise; }
    return complete(ctx, action, outcome, details);
  };
  const pending = mock.ports.logs.read(context(), query).catch((error: unknown) => error);
  await auditStarted.promise;
  const retention = mock.ports.retention!;
  await retention.recordTrigger(actor, { triggerRef: "end-poc", kind: "terminated", decidedAt: clock.utc(), scope: "poc" });
  clock.advance(30 * 86_400_000);
  const purge = retention.purgeDue(actor);
  await new Promise((resolve) => setTimeout(resolve, 150));
  clock.advance(5000);
  assert.equal((await purge).state, "partial");
  release.resolve();
  await pending;
  await new Promise(setImmediate);
  assert.equal((await retention.purgeDue(actor)).state, "deleted");
});

const query: LogQuery = { sourceRef: "simulator-source", applicationId: "SYNTHETIC-SECRET-APPLICATION",
  from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z", pageSize: 100 };
function context(overrides: Partial<CallContext> = {}): CallContext {
  return { caseRef: "case-1", phaseId: 1, callId: "call-1", principalRef: "principal-1", tenantRef: "tenant-1",
    destinationRef: "private-conversation-1", resourceRefs: ["simulator-source"], snapshotRef: "simulator-snapshot-1",
    policyVersion: "mock-policy-1", approvalRef: "synthetic-approval-1", budgetRef: "case-1", deadline: 30_000,
    signal: new AbortController().signal, ...overrides };
}

test("unknown fields, arbitrary endpoints, resources and source identifiers are denied before local protocol spawn", async () => {
  const mock = setup();
  for (const request of [ { ...query, endpoint: "https://invalid.test" }, { ...query, dsl: {} },
    { ...query, applicationId: "OTHER-APPLICATION" }, { ...query, sourceRef: "other" }, { ...query, pageSize: 101 } ]) {
    await assert.rejects(mock.ports.logs.read(context(), request as LogQuery), /^(Error: )?(invalid_request|denied)$/);
  }
  await assert.rejects(mock.ports.logs.read(context({ resourceRefs: ["other"] }), query), /denied/);
  await assert.rejects(mock.ports.code.search(context(), { repositoryRef: "../other", snapshotRef: "simulator-snapshot-1" }), /denied/);
  assert.equal(mock.events.some((event) => event.action === "audit:mcp.logs.read:intent" || event.action === "audit:mcp.code.search:intent"), false);
});

test("wire whitespace and Unicode escapes cannot bypass the logical response byte cap through progress notifications", async () => {
  for (const mode of ["whitespace", "escaped"]) {
    const mock = setup(mode);
    await assert.rejects(mock.ports.logs.read(context(), query), /unsafe_content/);
    assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send"), false);
  }
});

for (const [mode, reason] of [ ["manifest", "schema_mismatch"], ["output_schema", "schema_mismatch"], ["version", "version_mismatch"],
  ["malformed", "schema_mismatch"], ["extra_details", "invalid_request"], ["hidden_details", "schema_mismatch"],
  ["resource", "unsafe_content"], ["credential", "unsafe_content"], ["source_error", "unavailable"],
  ["cross_repository", "denied"], ["bad_path", "denied"], ["snapshot", "denied"], ["unsafe_progress", "unsafe_content"],
  ["hidden_progress", "schema_mismatch"], ["invalid_progress", "schema_mismatch"], ["forged_error", "unavailable"], ["invalid_utf8", "schema_mismatch"] ]) {
  test(`native MCP ${mode} is refused with a finite safe reason and no payload in output or retained audit`, async () => {
    const mock = setup(mode);
    await assert.rejects(mode === "cross_repository" || mode === "bad_path" || mode === "snapshot"
      ? mock.ports.code.search(context(), { repositoryRef: "simulator-source", snapshotRef: "simulator-snapshot-1" })
      : mock.ports.logs.read(context(), query), new RegExp(`^Error: ${reason}$`));
    const audits = mock.events.filter((event) => event.action.startsWith("audit:"));
    assert.doesNotMatch(JSON.stringify(audits), /SYNTHETIC-SECRET|password=|https:/);
    assert.equal(mock.events.some((event) => event.action === "model.generate" || event.action === "delivery.send"), false);
  });
}

test("untrusted source instructions remain evidence and cannot expand tools, authorization or report destination", async () => {
  const mock = setup("injection");
  await mock.receive();
  const { report, destinationRef } = await mock.delivery.next();
  assert.equal(destinationRef, "private-conversation-1");
  assert.match(report.evidence[0]!.text, /untrusted MCP evidence.*ignore prior rules/);
  assert.equal(mock.events.filter((event) => event.action === "audit:mcp.logs.read:intent").length, 1);
  assert.equal(mock.events.filter((event) => event.action === "audit:mcp.code.search:intent").length, 1);
});

test("16 KiB fragments include the untrusted-source label; one excess byte is rejected", async () => {
  const exact = setup("fragment_exact");
  const read = await exact.ports.logs.read(context(), query);
  assert.equal(Buffer.byteLength(read.evidence[0]!.text), 16_384);
  const over = setup("fragment_over");
  await assert.rejects(over.ports.logs.read(context(), query), /unsafe_content/);
});

test("the 256 KiB case body quota survives phases, pages and log/code endpoint changes", async () => {
  const mock = setup("large_page");
  for (let index = 0; index < 14; index++) {
    await mock.ports.logs.read(context({ callId: `call-${index}`, phaseId: index + 1 }), query);
  }
  await assert.rejects(mock.ports.code.search(context({ callId: "call-final", phaseId: 16 }),
    { repositoryRef: "simulator-source", snapshotRef: "simulator-snapshot-1" }), /unsafe_content/);
});

test("one MiB of actual wire bytes is accepted; one excess byte and cumulative padded pages are refused", async () => {
  assert.equal((await setup("wire_exact").ports.logs.read(context(), query)).evidence.length, 1);
  await assert.rejects(setup("wire_over").ports.logs.read(context(), query), /unsafe_content/);
  await assert.rejects(setup("padded_pages").ports.logs.read(context(), query), /unsafe_content/);
});

test("zero observations preserve unknown completeness and sanitized source warnings in the report and records", async () => {
  const mock = setup("zero");
  await mock.receive();
  const { report } = await mock.delivery.next();
  assert.equal(report.diagnosticStatus, "insufficient_evidence");
  assert.match(report.limitations.join(" "), /untrusted source warning: upstream completeness unknown for \[case-1:application\]/);
  assert.match(report.limitations.join(" "), /zero observations do not prove/);
  const record = await mock.ports.records.export(mock.inbound, "case-1");
  assert.match(JSON.stringify(record), /upstream completeness unknown/);
  assert.doesNotMatch(JSON.stringify(record), /SYNTHETIC-SECRET/);
});

for (const kind of ["logs", "code"] as const) test(`independent B ${kind} denial persists denied authorization in C before any MCP process starts`, async () => {
  const { SqliteRecords } = await import("../../src/adapters/records/sqlite.js");
  const directory = await mkdtemp(join(tmpdir(), "bau-mcp-denied-audit-")), receipt = join(directory, "operations");
  const action = `mcp.${kind === "logs" ? "logs.read" : "code.search"}`;
  let store: InstanceType<typeof SqliteRecords> | undefined;
  const mock = createMockTroubleshooting({ denyActions: [action], controlPorts: (ports) => {
    store = new SqliteRecords(directory, ports);
    return { admission: store.admission, records: store.records, deliveryLedger: store.deliveryLedger, audit: store.audit, budget: store.budget };
  } });
  try {
    await mock.receive(); await mock.closed;
    const before = mock.events.filter((event) => ["model.generate", "delivery.send"].includes(event.action)).length;
    const source = { ...endpoint(), args: [service, "normal", receipt] };
    const adapter = mcpEvidencePorts(mock.ports, { logs: source, code: source, resolveIdentifier: (_context, id) => id });
    const denied = kind === "logs" ? adapter.logs.read(context(), query) : adapter.code.search(context(), { repositoryRef: "simulator-source", snapshotRef: "simulator-snapshot-1" });
    await assert.rejects(denied, /^Error: denied$/);
    const retained = await mock.ports.records.export(mock.inbound, "case-1"); assert.ok(retained?.scope === "full");
    const audit = retained.audits.find((row) => row.action === "authorization.denied" && row.stage === "complete");
    assert.ok(audit); assert.deepEqual(audit.authorization, { decision: "denied", reason: "denied" });
    assert.equal(retained.audits.some((row) => row.action === action && row.outcome === "denied"), false);
    await assert.rejects(readFile(receipt), { code: "ENOENT" });
    assert.equal(mock.events.filter((event) => ["model.generate", "delivery.send"].includes(event.action)).length, before);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});
