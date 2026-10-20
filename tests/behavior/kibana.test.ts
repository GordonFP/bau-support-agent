import { test } from "node:test";
import { once } from "node:events";
import assert from "node:assert/strict";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { McpBoundary } from "../../src/adapters/mcp/boundary.js";
import { loadKibanaProfile, kibanaLogPorts } from "../../src/adapters/kibana/logs.js";
import { kibanaProfile, kibanaServer } from "../fixtures/kibana.js";
import type { CallContext, LogQuery } from "../../src/troubleshooting/application/ports.js";
const query: LogQuery = { sourceRef: "simulator-source", applicationId: "SYNTHETIC-SECRET-APPLICATION", from: "2026-10-18T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z", pageSize: 100 };
const context = (now: number, extra: Partial<CallContext> = {}): CallContext => ({ caseRef: "case-1", phaseId: 1, callId: "logs-1", principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1", approvalRef: "approved", policyVersion: "poc-1", resourceRefs: ["simulator-source"], snapshotRef: "simulator-snapshot-1", budgetRef: "budget-1", deadline: now + 30_000, signal: new AbortController().signal, ...extra });

test("B compiles a bounded association query and translates native text without manufacturing complete coverage", async () => {
  const server = await kibanaServer(); const artifact = await kibanaProfile(server.url);
  const mock = createMockTroubleshooting();
  try {
    const profile = await loadKibanaProfile(artifact);
    const adapter = kibanaLogPorts(mock.ports, { profile, resolveIdentifier: (_context, id) => id }, new McpBoundary(mock.ports));
    const result = await adapter.logs.read(context(mock.ports.clock.now()), query);
    assert.equal(result.completeness, "unknown"); assert.equal(result.truncated, false);
    assert.ok(result.value && !("kind" in result.value));
    assert.equal(result.value.submittedOn, "2026-10-18"); assert.equal(result.value.shops[0]!.coverageComplete, false);
    assert.equal(result.evidence[0]!.observedAt, "2026-10-18T23:00:00.000Z");
    assert.equal(result.evidence[0]!.log!.from, query.from); assert.equal(result.evidence[0]!.log!.to, query.to);
    assert.match(result.warnings.join(" "), /completeness.*unknown/i);
    assert.equal(server.requests.length, 1);
    assert.deepEqual(server.requests[0]!.body.params.body, { query: { bool: { filter: [
      { term: { application_id: "SYNTHETIC-SECRET-APPLICATION" } }, { range: { event_time: { gte: query.from, lt: query.to } } },
    ] } }, size: 100, from: 0, sort: [{ event_time: "asc" }, { event_id: "asc" }] });
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC-SECRET|127\.0\.0\.1|controlled\.json/);
  } finally { await artifact.close(); await server.close(); }
});

test("A through actual Pi, Responses, native MCP and owned ES delivers an honest Simulator report retained by C", async () => {
  const { createPiRuntime } = await import("../../src/adapters/pi/runtime.js");
  const { createResponsesGateway, responsesModelPolicy } = await import("../../src/adapters/model/responses.js");
  const { responsesServer, reportIn, sendTool, sendText } = await import("../fixtures/responses.js");
  const { resolve } = await import("node:path");
  const server = await kibanaServer(); const artifact = await kibanaProfile(server.url); const profile = await loadKibanaProfile(artifact);
  const model = await responsesServer((body, response) => {
    const called = (body.input as { type?: string; name?: string }[]).some((item) => item.type === "function_call" && item.name === "logs_read");
    if (!called) sendTool(response, { name: "logs_read", done: true, terminal: true });
    else sendText(response, JSON.stringify(reportIn(body)), { synthetic_source: "mock_usage", synthetic_cost_microusd: 1_000 });
  });
  const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol", controlPorts: (ports) => ({ records: ports.records,
    ...kibanaLogPorts(ports, { profile, resolveIdentifier: (_context, id) => id }, new McpBoundary(ports)) }) });
  const pi = await createPiRuntime({ skillPath: resolve("runtime-skills/bau-troubleshooting/SKILL.md"), clock: mock.ports.clock });
  const close = mock.ports.agent.close;
  mock.ports.agent.run = pi.run; mock.ports.agent.abort = pi.abort;
  mock.ports.agent.close = async (caseRef, phaseId) => { await pi.close(caseRef, phaseId); await close(caseRef, phaseId); };
  mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", baseUrl: model.baseUrl, contract: responsesModelPolicy.protocol, clock: mock.ports.clock }).generate;
  try {
    assert.equal((await mock.receive()).status, "accepted"); await mock.closed;
    const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view && view.state === "completed", JSON.stringify(view));
    const sent = await mock.delivery.next(); assert.deepEqual(sent.report.simulator.dataReadiness, { satisfied: 0, missing: 0, unknown: 1 });
    assert.notEqual(sent.report.diagnosticStatus, "located"); assert.match(sent.report.limitations.join(" "), /completeness.*unknown/i);
    assert.equal(sent.report.evidence[0]!.completeness, "unknown"); assert.equal(server.requests.length, 1); assert.equal(model.requests.length, 2);
    const retained = await mock.ports.records.export(mock.inbound, "case-1"); assert.ok(retained?.scope === "full");
    assert.ok(retained.audits.some((row) => row.action === "mcp.logs.read" && row.stage === "complete" && row.outcome === "ok"));
    assert.doesNotMatch(JSON.stringify({ sent, retained, model: model.requests }), /SYNTHETIC-SECRET|127\.0\.0\.1|controlled\.json|node_modules|\/Users\//);
  } finally { await pi.abort("case-1", 1); await pi.close("case-1", 1); await model.close(); await artifact.close(); await server.close(); }
});

async function nativeRead(handler: Parameters<typeof kibanaServer>[0], run: (adapter: ReturnType<typeof kibanaLogPorts>, mock: ReturnType<typeof createMockTroubleshooting>, server: Awaited<ReturnType<typeof kibanaServer>>) => Promise<void>, changeProfile?: Parameters<typeof kibanaProfile>[1]) {
  const server = await kibanaServer(handler), artifact = await kibanaProfile(server.url, changeProfile), mock = createMockTroubleshooting();
  try { const profile = await loadKibanaProfile(artifact); await run(kibanaLogPorts(mock.ports, { profile, resolveIdentifier: (_context, id) => id }, new McpBoundary(mock.ports)), mock, server); }
  finally { await artifact.close(); await server.close(); }
}

test("B rejects arbitrary query controls, invalid calendars, foreign scopes and customer discovery before native HTTP", async () => {
  await nativeRead(undefined, async (adapter, mock, server) => {
    const bad = [ { ...query, index: "other" }, { ...query, query: { match_all: {} } }, { ...query, pageSize: -1 },
      { ...query, from: "2026-02-29T00:00:00.000Z" }, { ...query, from: "2026-10-17T00:00:00.000Z" },
      { ...query, applicationId: undefined, customerId: "SYNTHETIC-SECRET-CUSTOMER" } ];
    for (const value of bad) await assert.rejects(adapter.logs.read(context(mock.ports.clock.now()), value as LogQuery), /invalid_request|contract_unverified/);
    await assert.rejects(adapter.logs.read(context(mock.ports.clock.now(), { resourceRefs: ["simulator-source", "unapproved"] }), query), /denied/);
    assert.equal(server.requests.length, 0);
  });
});

for (const mode of ["target", "index", "event", "future_submission", "submillisecond", "calendar", "timezone", "cardinality", "depth", "prototype", "fragment"] as const) test(`B rejects untrusted native ${mode} drift before evidence delivery`, async () => {
  const { logRow, esBody } = await import("../fixtures/kibana.js");
  await nativeRead((_body, response) => {
    const row: any = logRow();
    if (mode === "target") row._source.application_id = "foreign-application";
    if (mode === "index") row._index = "other-index";
    if (mode === "event") row._source.event_time = "2026-10-19T00:00:00.000Z";
    if (mode === "future_submission") row._source.submitted_at = "2026-10-19T01:00:00.000Z";
    if (mode === "submillisecond") row._source.event_time = "2026-10-18T23:00:00.0001Z";
    if (mode === "calendar") row._source.submitted_shops[0].coverage_through = "2026-02-29";
    if (mode === "timezone") row._source.business_timezone = "Unreviewed/Unknown";
    if (mode === "cardinality") row._source.submitted_shops = Array.from({ length: 101 }, (_, i) => ({ ...row._source.submitted_shops[0], shop_id: `s${i}` }));
    if (mode === "depth") row._source.submitted_shops[0].coverage_through = { a: { b: { c: { d: "untrusted" } } } };
    if (mode === "prototype") row._source = JSON.parse(JSON.stringify(row._source).replace('{', '{"__proto__":{"proxy":"http://untrusted.invalid"},'));
    if (mode === "fragment") row._source.submitted_shops = Array.from({ length: 80 }, (_, i) => ({ ...row._source.submitted_shops[0], shop_id: `s${i}-` + "x".repeat(500) }));
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rawResponse: esBody([row]) }));
  }, async (adapter, mock, server) => {
    await assert.rejects(adapter.logs.read(context(mock.ports.clock.now()), query), /denied|schema_mismatch|unsafe_content/);
    assert.equal(server.requests.length, 1); assert.equal(mock.events.some((event) => event.action === "delivery.send" || event.action === "model.generate"), false);
    assert.doesNotMatch(JSON.stringify(mock.events), /http:\/\/untrusted|foreign-application/);
  });
});

test("B reserves 500 unknown raw rows across failed requests and phases without automatic replay or reset", async () => {
  await nativeRead((_body, response) => response.writeHead(503, { "content-type": "application/json" }).end('{"message":"password=SYNTHETIC-SECRET-failure http://untrusted.invalid"}'), async (adapter, mock, server) => {
    for (let phaseId = 1; phaseId <= 5; phaseId++) await assert.rejects(adapter.logs.read(context(mock.ports.clock.now(), { phaseId, callId: `call-${phaseId}` }), query), /^Error: unavailable$/);
    await assert.rejects(adapter.logs.read(context(mock.ports.clock.now(), { phaseId: 6, callId: "call-6" }), query), /^Error: budget_exhausted$/);
    assert.equal(server.requests.length, 5); assert.doesNotMatch(JSON.stringify(mock.events), /SYNTHETIC-SECRET-failure|untrusted\.invalid/);
  });
});

test("B caps case coverage at seven days across phases even for zero-hit queries", async () => {
  const { esBody } = await import("../fixtures/kibana.js");
  await nativeRead((_body, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rawResponse: esBody([]) })), async (adapter, mock, server) => {
    for (let day = 1; day <= 7; day++) {
      const value = await adapter.logs.read(context(mock.ports.clock.now(), { phaseId: day }), { ...query, from: `2026-10-0${day}T00:00:00.000Z`, to: `2026-10-0${day + 1}T00:00:00.000Z` });
      assert.equal(value.value, null); assert.equal(value.completeness, "unknown"); assert.match(value.warnings.join(" "), /unknown/);
    }
    await assert.rejects(adapter.logs.read(context(mock.ports.clock.now(), { phaseId: 8 }), { ...query, from: "2026-10-08T00:00:00.000Z", to: "2026-10-09T00:00:00.000Z" }), /budget_exhausted/);
    assert.equal(server.requests.length, 7);
  });
});

test("B preserves unknown partial and missing-page warnings, including zero observations", async () => {
  const { esBody } = await import("../fixtures/kibana.js");
  await nativeRead((_body, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rawResponse: { ...esBody([], 2), timed_out: true, _shards: { total: 2, successful: 1, failed: 1 } } })), async (adapter, mock) => {
    const result = await adapter.logs.read(context(mock.ports.clock.now()), query);
    assert.equal(result.value, null); assert.equal(result.completeness, "unknown"); assert.equal(result.truncated, true);
    assert.match(result.warnings.join(" "), /Missing native page/);
  });
});

for (const mode of ["redirect", "reset", "invalid_json", "gzip", "stream_overflow"] as const) test(`B confines native HTTP ${mode} and returns a finite source failure`, async () => {
  const { esBody, logRow } = await import("../fixtures/kibana.js");
  const { gzipSync } = await import("node:zlib");
  let redirected = 0, sent = 0, finished = false;
  const target = await kibanaServer((_body, response) => { redirected++; response.writeHead(200).end("{}"); });
  try { await nativeRead(async (_body, response) => {
    if (mode === "redirect") { response.writeHead(307, { location: target.url + "/internal/search/es" }).end(); return; }
    if (mode === "reset") { response.destroy(); return; }
    if (mode === "invalid_json") { response.writeHead(200, { "content-type": "application/json" }).end('{"rawResponse":'); return; }
    const row: any = logRow(); row._source.payload = "x".repeat(1_300_000);
    const bytes = Buffer.from(JSON.stringify({ rawResponse: esBody([row]) }));
    if (mode === "gzip") { const zipped = gzipSync(bytes); assert.ok(zipped.length < 4_000); response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }).end(zipped); return; }
    response.writeHead(200, { "content-type": "application/json" });
    try { for (let offset = 0; offset < bytes.length; offset += 16_384) {
      if (response.destroyed) break; const part = bytes.subarray(offset, offset + 16_384); sent += part.length;
      if (!response.write(part)) await Promise.race([once(response, "drain"), once(response, "close")]);
      await new Promise((done) => setTimeout(done, 1));
    } if (!response.destroyed) { finished = true; response.end(); } } catch { /* Owned native child closed this response. */ }
  }, async (adapter, mock, server) => {
    await assert.rejects(adapter.logs.read(context(mock.ports.clock.now()), query), /^Error: unavailable$/);
    assert.equal(server.requests.length, 1); assert.equal(redirected, 0);
    if (mode === "stream_overflow") { assert.ok(sent >= 1_048_576 && sent < 1_300_000); assert.equal(finished, false); }
    assert.doesNotMatch(JSON.stringify(mock.events), /127\.0\.0\.1|SYNTHETIC-SECRET|payload/);
  }); } finally { await target.close(); }
});

test("B cancellation discards native results but does not claim the owned ES work stopped or replay it", async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let backendWorkEnded = false;
  const { esBody } = await import("../fixtures/kibana.js");
  await nativeRead(async (_body, response) => { started.resolve(); await release.promise; backendWorkEnded = true; if (!response.destroyed) response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rawResponse: esBody() })); }, async (adapter, mock, server) => {
    const controller = new AbortController();
    const pending = adapter.logs.read(context(mock.ports.clock.now(), { signal: controller.signal }), query);
    await started.promise; controller.abort(); await assert.rejects(pending, /^Error: cancelled$/);
    assert.equal(server.requests.length, 1); assert.equal(backendWorkEnded, false);
    assert.equal(mock.events.some((event) => event.action === "delivery.send" || event.action === "model.generate"), false);
    release.resolve(); await new Promise(setImmediate); assert.equal(backendWorkEnded, true);
  });
});

test("B detects reviewed manifest drift before the native search and refuses automatic tool trust", async () => {
  await nativeRead(undefined, async (adapter, mock, server) => {
    await assert.rejects(adapter.logs.read(context(mock.ports.clock.now()), query), /^Error: schema_mismatch$/); assert.equal(server.requests.length, 0);
  }, (value) => { value.manifest.tools[0].description = "unreviewed drift"; });
});

test("B sorts actual UTC instants across fractional precision and preserves source business timezone", async () => {
  const { logRow, esBody } = await import("../fixtures/kibana.js");
  await nativeRead((_body, response) => {
    const rows = [logRow(1), logRow(2)];
    rows[0]!._source.event_time = "2026-10-18T23:00:00Z"; rows[1]!._source.event_time = "2026-10-18T23:00:00.100Z";
    for (const row of rows) row._source.submitted_at = "2026-10-18T18:00:00Z";
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rawResponse: esBody(rows) }));
  }, async (adapter, mock) => {
    const result = await adapter.logs.read(context(mock.ports.clock.now()), query);
    assert.equal(result.evidence.length, 2); assert.ok(result.value && !("kind" in result.value)); assert.equal(result.value.submittedOn, "2026-10-19");
    assert.deepEqual(result.evidence.map((item) => item.observedAt), ["2026-10-18T23:00:00Z", "2026-10-18T23:00:00.100Z"]);
  });
});

test("B pages native offsets serially and retains all received rows as unknown evidence", async () => {
  const { logRow, esBody } = await import("../fixtures/kibana.js");
  await nativeRead((body, response) => {
    const from = body.params.body.from as number;
    const rows = Array.from({ length: from === 0 ? 100 : 1 }, (_, index) => logRow(from + index + 1));
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rawResponse: esBody(rows, 101) }));
  }, async (adapter, mock, server) => {
    const result = await adapter.logs.read(context(mock.ports.clock.now()), query);
    assert.equal(result.evidence.length, 101); assert.equal(result.completeness, "unknown");
    assert.deepEqual(server.requests.map((request) => request.body.params.body.from), [0, 100]);
    assert.ok(result.evidence.every((item) => item.completeness === "unknown"));
  });
});

test("B refuses a missing pinned import in the actual artifact closure before native HTTP", async () => {
  await nativeRead(undefined, async (adapter, mock, server) => {
    await assert.rejects(adapter.logs.read(context(mock.ports.clock.now()), query), /^Error: unavailable$/); assert.equal(server.requests.length, 0);
  }, (value) => { value.modules.splice(1, 1); });
});

for (const persistence of ["mock", "sqlite"] as const) test(`B authorization refusal persists a denied decision through C ${persistence} export`, async () => {
  const { SqliteRecords } = await import("../../src/adapters/records/sqlite.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "bau-denied-log-audit-"));
  let store: InstanceType<typeof SqliteRecords> | undefined;
  const mock = createMockTroubleshooting({ denyActions: ["mcp.logs.read"], controlPorts: (ports) => {
    if (persistence === "mock") return {};
    store = new SqliteRecords(directory, ports);
    return { admission: store.admission, records: store.records, audit: store.audit, budget: store.budget };
  } });
  const server = await kibanaServer(), artifact = await kibanaProfile(server.url);
  try {
    await mock.receive(); await mock.closed;
    const before = mock.events.filter((event) => ["model.generate", "delivery.send"].includes(event.action)).length;
    const profile = await loadKibanaProfile(artifact);
    const adapter = kibanaLogPorts(mock.ports, { profile, resolveIdentifier: (_context, id) => id }, new McpBoundary(mock.ports));
    await assert.rejects(adapter.logs.read(context(mock.ports.clock.now()), query), /^Error: denied$/);
    const retained = await mock.ports.records.export(mock.inbound, "case-1"); assert.ok(retained?.scope === "full");
    const denial = retained.audits.find((row) => row.action === "authorization.denied" && row.stage === "complete");
    assert.ok(denial); assert.deepEqual(denial.authorization, { decision: "denied", reason: "denied" });
    assert.equal(denial.principalRef, mock.inbound.principalRef);
    assert.equal(retained.audits.some((row) => row.action === "mcp.logs.read" && row.outcome === "denied"), false);
    assert.equal(server.requests.length, 0);
    assert.equal(mock.events.filter((event) => ["model.generate", "delivery.send"].includes(event.action)).length, before);
    assert.doesNotMatch(JSON.stringify(retained), /SYNTHETIC-SECRET|127\.0\.0\.1|controlled\.json/);
  } finally { store?.close(); await artifact.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
