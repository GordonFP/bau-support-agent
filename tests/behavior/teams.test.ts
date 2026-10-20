import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalTeamsHost } from "../../src/adapters/teams/host.js";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { teamsServices } from "../fixtures/teams.js";

test("D rejects an oversized malformed raw body before JSON or application intake", async () => {
  const service = await teamsServices();
  const mock = createMockTroubleshooting();
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  try {
    await host.start();
    const response = await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: "{" + "x".repeat(65_536) });
    assert.equal(response.status, 413);
    assert.equal(mock.events.length, 0); assert.equal(service.tokenRequests(), 0); assert.equal(service.writes.length, 0);
  } finally { await host.stop(); await service.close(); }
});

test("a signed fixed personal activity plus a separate user proof becomes durable A acceptance before investigation", async () => {
  const service = await teamsServices(); const mock = createMockTroubleshooting();
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  try {
    await host.start();
    const response = await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(service.activity()) });
    assert.equal(response.status, 200); assert.equal((await response.json() as { status: string }).status, "accepted");
    await mock.closed;
    assert.ok(service.tokenRequests() > 0);
    const saved = await mock.ports.records.read(service.mapping.actor, "case-1");
    assert.ok(saved?.scope === "full"); assert.equal(saved.view.state, "completed");
    assert.equal(saved.records.filter((record) => record.kind === "input").length, 1);
  } finally { await host.stop(); await service.close(); }
});

test("the actual SDK delivers only fixed status and validated report children to the host-bound conversation", async () => {
  const service = await teamsServices(); const mock = createMockTroubleshooting();
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  try {
    await host.start();
    await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(service.activity()) });
    await mock.closed;
    assert.equal(service.writes.length, 2, "one application status and one validated report");
    assert.ok(service.writes.every((write) => write.path === "/v3/conversations/synthetic-conversation/activities" && typeof write.body.text === "string" && write.body.textFormat === "plain"));
    assert.doesNotMatch(JSON.stringify(service.writes), /SYNTHETIC-SECRET|attachments|recipient|isTargeted/);
  } finally { await host.stop(); await service.close(); }
});

test("a verified Teams query uses current A.get and returns only the finite case status", async () => {
  const service = await teamsServices(); const mock = createMockTroubleshooting();
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  const post = (body: unknown) => fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(body) });
  try {
    await host.start(); await post(service.activity()); await mock.closed;
    const response = await post({ ...service.activity(JSON.stringify({ action: "get", caseRef: "case-1" })), id: "query-event" });
    assert.deepEqual(await response.json(), { status: "case", caseRef: "case-1", phaseId: 1, state: "completed", deliveryStatus: "delivered" });
    assert.equal(service.writes.length, 2);
    assert.ok(mock.events.some((event) => event.action === "audit:get:complete"));
  } finally { await host.stop(); await service.close(); }
});

test("unverified service/user proofs and conflicting private identity never reach business ports or delivery", async () => {
  const service = await teamsServices(); const mock = createMockTroubleshooting();
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  try {
    await host.start();
    for (const mode of ["missing-service", "forged-service", "expired-service", "forged", "revoked", "expired", "wrong-scope", "wrong-tenant", "wrong-user", "group", "missing-oid", "body-principal", "wrong-bot", "conflicting-tenant"]) {
      service.setTokenMode(mode);
      const activity: Record<string, unknown> = { ...service.activity(), id: `event-${mode}` };
      if (mode === "group") activity.conversation = { ...service.activity().conversation, conversationType: "groupChat" };
      if (mode === "missing-oid") activity.from = { id: "synthetic-user", name: "principal-1" };
      if (mode === "body-principal") activity.from = { id: "intruder", aadObjectId: "synthetic-oid", name: "principal-1" };
      if (mode === "wrong-bot") activity.recipient = { id: "other-bot" };
      if (mode === "conflicting-tenant") activity.channelData = { tenant: { id: "other-tenant" } };
      const token = service.serviceToken(mode === "forged-service", mode === "expired-service" ? { exp: 1 } : {});
      const response = await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", ...(mode === "missing-service" ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(activity) });
      const result: unknown = await response.json();
      assert.deepEqual(result, { status: "denied" }, mode);
    }
    assert.equal(mock.events.some((event) => ["logs.read", "model.generate", "delivery.notice", "delivery.send"].includes(event.action)), false);
    assert.equal(service.writes.length, 0);
    assert.doesNotMatch(JSON.stringify(mock.events), /synthetic-user|SYNTHETIC-SECRET/);
  } finally { await host.stop(); await service.close(); }
});

test("a verified cancel reuses A.cancel and sends a fixed stopped status without starting another investigation", async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const service = await teamsServices(); const mock = createMockTroubleshooting({ agent: async (context) => { started.resolve(); context.signal.addEventListener("abort", () => release.resolve(), { once: true }); await release.promise; return {}; } });
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  const post = (body: unknown) => fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(body) });
  try {
    await host.start(); await post(service.activity()); await started.promise;
    const cancelling = post({ ...service.activity(JSON.stringify({ action: "cancel", caseRef: "case-1" })), id: "cancel-event" });
    // Give a denied response a finite assertion before waiting for the actual abort.
    const response = await cancelling;
    const status = await response.json() as { state?: string };
    assert.equal(status.state, "stopped");
    release.resolve(); await mock.closed;
    assert.ok(service.writes.some((write) => (JSON.parse(String(write.body.text)) as { state?: string }).state === "stopped"));
    assert.equal(mock.events.some((event) => event.action === "logs.read" || event.action === "model.generate"), false);
  } finally { release.resolve(); await host.stop(); await service.close(); }
});

test("only the delivered question receipt bound to this actor and case can resume the same investigation", async () => {
  const service = await teamsServices();
  const candidates = [{ applicationId: "SYNTHETIC-SECRET-APPLICATION", submittedAt: "2026-10-18T10:00:00.000Z" },
    { applicationId: "other-application", submittedAt: "2026-10-19T10:00:00.000Z" }];
  const mock = createMockTroubleshooting({ customerCandidates: candidates });
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  const post = (body: unknown) => fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(body) });
  try {
    await host.start(); await post(service.activity(JSON.stringify({ action: "investigate", customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" }))); await mock.phaseClosed(1);
    assert.equal(service.writes.length, 2);
    const reply = { ...service.activity(JSON.stringify({ action: "provide_information", caseRef: "case-1", questionId: "case-1:question:1", content: { submittedAt: candidates[0]!.submittedAt } })), id: "reply-event", replyToId: "forged-receipt" };
    assert.deepEqual(await (await post(reply)).json(), { status: "denied" });
    const response = await post({ ...reply, replyToId: "synthetic-receipt-2" });
    const result = await response.json() as { status: string; caseRef?: string; phaseId?: number };
    assert.deepEqual(result, { status: "resumed", caseRef: "case-1", phaseId: 2 });
    await mock.phaseClosed(2);
    assert.equal((await mock.ports.budget.status("case-1")).attempts, 1);
    const writes = service.writes.length;
    assert.equal((await (await post({ ...reply, replyToId: "synthetic-receipt-2" })).json() as { status: string }).status, "duplicate");
    assert.equal(service.writes.length, writes);
  } finally { await host.stop(); await service.close(); }
});

test("native result-audit failure permits only the fixed data-free fault through the final write guard", async () => {
  const service = await teamsServices(); const mock = createMockTroubleshooting({ auditFails: "logs.read:complete" });
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  try {
    await host.start(); await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(service.activity()) });
    await mock.closed; await service.waitForWrites(2);
    assert.equal(service.writes.length, 2);
    assert.equal(service.writes[1]!.body.text, "Investigation stopped because audit storage is unavailable.");
    assert.equal(mock.events.some((event) => event.action === "model.generate"), false);
    assert.doesNotMatch(JSON.stringify(service.writes), /SYNTHETIC-SECRET|shops|simulator/);
  } finally { await host.stop(); await service.close(); }
});

test("C retains a partial deletion while native token acquisition still holds data after its bounded proof reply", async () => {
  const { ManualClock } = await import("../fixtures/clock.js");
  const clock = new ManualClock();
  const owner = { principalRef: "lifecycle-owner", tenantRef: "tenant-1", destinationRef: "lifecycle-path" };
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let report = false, count = 0;
  const service = await teamsServices();
  const token = service.configuration.token;
  const mock = createMockTroubleshooting({ clock, lifecycleActors: [owner], model: async (_context, draft) => { report = true; return { candidate: draft, actualMicrousd: 1_000 }; } });
  const host = await createLocalTeamsHost({ ...service.configuration, token: async () => {
    if (report && ++count === 2) { held.resolve(); await release.promise; } return token();
  } }, { application: mock.application, ports: mock.ports });
  const retention = mock.ports.retention!;
  try {
    await retention.recordTrigger(owner, { triggerRef: "poc-ended", scope: "poc", kind: "terminated", decidedAt: clock.utc() });
    await host.start(); await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(service.activity()) });
    await held.promise; clock.advance(5_000); await mock.closed;
    clock.advance(30 * 86_400_000);
    const deleting = retention.purgeDue(owner);
    await new Promise(setImmediate); clock.advance(5_000);
    assert.equal((await deleting).state, "partial");
    release.resolve(); await new Promise(setImmediate); await host.stop();
    assert.equal((await retention.purgeDue(owner)).state, "deleted");
    assert.equal(service.writes.length, 1);
  } finally { release.resolve(); await host.stop(); await service.close(); }
});

test("signed Teams intake acknowledges independently and completes actual Pi, Responses and two native MCP services before native delivery", async () => {
  const { responsesServer } = await import("../fixtures/responses.js");
  const { nativeTroubleshooting, simulatorResponse } = await import("../fixtures/pi-runtime.js");
  const release = Promise.withResolvers<void>(), modelStarted = Promise.withResolvers<void>();
  const responses = await responsesServer(async (body, response) => { modelStarted.resolve(); await release.promise; simulatorResponse(body, response); });
  const { mock, pi } = await nativeTroubleshooting(responses.baseUrl);
  const service = await teamsServices();
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  try {
    await host.start();
    const response = await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(service.activity()) });
    assert.equal((await response.json() as { status: string }).status, "accepted");
    await modelStarted.promise; assert.equal(service.writes.length, 1);
    release.resolve(); await mock.closed; await service.waitForWrites(2);
    const records = await mock.ports.records.read(service.mapping.actor, "case-1");
    assert.ok(records?.scope === "full"); assert.equal(records.view.state, "completed");
    const report = records.records.find((record) => record.kind === "report"); assert.ok(report);
    const delivered = JSON.parse(String(service.writes[1]!.body.text)) as { simulator: { shopCount: number }; evidence: unknown[] };
    assert.equal(delivered.simulator.shopCount, 10); assert.equal(delivered.evidence.length, 2);
    assert.deepEqual(delivered, report.payload); assert.equal(responses.requests.length, 3);
    assert.doesNotMatch(JSON.stringify({ writes: service.writes, records }), /SYNTHETIC-SECRET|\/Users\/|\/private\//);
  } finally { release.resolve(); await host.stop(); await pi.abort("case-1", 1); await pi.close("case-1", 1); await service.close(); await responses.close(); }
});

test("host shutdown closes active phases and admission even when the owner has lost cancel permission", async () => {
  const service = await teamsServices(); const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const deny: string[] = [];
  const mock = createMockTroubleshooting({ denyActions: deny, agent: async (context) => {
    started.resolve(); context.signal.addEventListener("abort", () => release.resolve(), { once: true }); await release.promise; return {};
  } });
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  try {
    await host.start(); await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(service.activity()) });
    await started.promise; deny.push("cancel");
    assert.equal(await host.stop(), "closed");
    const after = await mock.receive({ eventRef: "after-stop" });
    assert.equal(after.status, "service_unavailable");
    assert.deepEqual(await mock.application.get(service.mapping.actor, "case-1"), { status: "denied" });
    assert.equal(service.writes.length, 1);
    const records = await mock.ports.records.read(service.mapping.actor, "case-1"); assert.ok(records, "normal stop retains durable records");
  } finally { release.resolve(); await host.stop(); await service.close(); }
});

test("a confirmed but pre-ack admission remains unknown during shutdown and its late completion cannot start a phase", async () => {
  const { ManualClock } = await import("../fixtures/clock.js"); const clock = new ManualClock();
  const confirmed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const service = await teamsServices();
  const mock = createMockTroubleshooting({ clock, controlPorts: (ports) => { const admission = ports.admission; return { admission: { ...admission, confirm: async (record) => {
    const result = await admission.confirm(record); confirmed.resolve(); await release.promise; return result;
  } } }; } });
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  try {
    await host.start();
    const receiving = fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(service.activity()) }).catch(() => null);
    await confirmed.promise;
    const stopping = host.stop(); await new Promise(setImmediate); clock.advance(5_000);
    assert.equal(await stopping, "unknown");
    release.resolve(); await receiving; await new Promise(setImmediate); await host.stop();
    const saved = await mock.ports.records.read(service.mapping.actor, "case-1");
    assert.ok(saved?.scope === "full"); assert.equal(saved.view.state, "stopped");
    assert.equal(mock.events.some((event) => ["logs.read", "model.generate", "audit:accept:complete"].includes(event.action)), false);
    assert.equal(service.writes.length, 0);
  } finally { release.resolve(); await host.stop(); await service.close(); }
});

test("a consumed report with lost acknowledgement stays durably unknown across native host restart and every duplicate", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { SqliteRecords } = await import("../../src/adapters/records/sqlite.js");
  const directory = await mkdtemp(join(tmpdir(), "bau-teams-unknown-"));
  const service = await teamsServices(); let store: InstanceType<typeof SqliteRecords> | undefined;
  const controls = (ports: ReturnType<typeof createMockTroubleshooting>["ports"]) => { store = new SqliteRecords(directory, ports); return { records: store.records, audit: store.audit, admission: store.admission, budget: store.budget, retention: store.retention }; };
  const first = createMockTroubleshooting({ controlPorts: controls, model: async (_context, draft) => { service.setWriteMode("reset"); return { candidate: draft, actualMicrousd: 1_000 }; } });
  const host = await createLocalTeamsHost(service.configuration, { application: first.application, ports: first.ports });
  let restarted: Awaited<ReturnType<typeof createLocalTeamsHost>> | undefined;
  const post = (url: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(service.activity()) });
  try {
    await host.start(); const accepted = await (await post(host.url)).json() as { caseRef: string };
    await first.closed; await new Promise(setImmediate);
    const saved = await first.ports.records.read(service.mapping.actor, accepted.caseRef);
    assert.ok(saved?.scope === "full"); assert.equal(saved.view.deliveryStatus, "unknown");
    assert.equal(saved.deliveries.filter((item) => item.deliveryKey.endsWith(":report:1"))[0]!.status, "unknown");
    assert.equal(service.writes.length, 2);
    await host.stop(); store!.close();
    const next = createMockTroubleshooting({ controlPorts: controls });
    restarted = await createLocalTeamsHost(service.configuration, { application: next.application, ports: next.ports }); await restarted.start();
    const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const complete = store!.audit.complete;
    store!.audit.complete = async (context, action, outcome, details) => { await complete(context, action, outcome, details); if (action === "records.read") { held.resolve(); await release.promise; } };
    const querying = fetch(restarted.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` },
      body: JSON.stringify({ ...service.activity(JSON.stringify({ action: "get", caseRef: accepted.caseRef })), id: "restarted-query" }) });
    await held.promise; service.setTokenMode("revoked"); release.resolve();
    assert.deepEqual(await (await querying).json(), { status: "denied" }, "restarted C reads obey the same final proof gate");
    service.setTokenMode("valid");
    for (let count = 0; count < 2; count++) assert.deepEqual(await (await post(restarted.url)).json(), { status: "duplicate", caseRef: accepted.caseRef, phaseId: 1 });
    assert.equal(service.writes.length, 2);
    assert.equal(next.events.some((event) => ["logs.read", "model.generate", "delivery.send", "delivery.notice"].includes(event.action)), false);
    const durable = await next.ports.records.read(service.mapping.actor, accepted.caseRef);
    assert.ok(durable?.scope === "full"); assert.equal(durable.view.deliveryStatus, "unknown");
    assert.ok(durable.audits.some((event) => event.action === "authorization.denied" && event.stage === "complete"));
  } finally { await host.stop(); await restarted?.stop(); store?.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const failure of ["revoked", "expired"]) test(`${failure} while query audit is held prevents all case metadata in the eventual HTTP reply`, async () => {
  const service = await teamsServices(); const mock = createMockTroubleshooting();
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const complete = mock.ports.audit.complete;
  mock.ports.audit.complete = async (context, action, outcome, details) => { await complete(context, action, outcome, details); if (action === "get") { held.resolve(); await release.promise; } };
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  const post = (body: unknown) => fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(body) });
  try {
    await host.start(); await post(service.activity()); await mock.closed;
    const querying = post({ ...service.activity(JSON.stringify({ action: "get", caseRef: "case-1" })), id: "held-query" });
    await held.promise; service.setTokenMode(failure); release.resolve();
    assert.deepEqual(await (await querying).json(), { status: "denied" });
    assert.ok(mock.events.some((event) => event.action === "audit:authorization.denied:complete"), "the final disclosure denial must be audited");
  } finally { release.resolve(); await host.stop(); await service.close(); }
});

for (const outcome of ["revoked", "unknown"] as const) test(`native child ${outcome} stops later segments and each physical activity respects the smaller platform cap`, async () => {
  const service = await teamsServices(); const deny: string[] = [];
  const mock = createMockTroubleshooting({ denyActions: deny });
  service.beforeToken(async () => { if (service.writes.length >= 2) { if (outcome === "revoked") deny.push("delivery.send"); else service.setWriteMode("reset"); } });
  const host = await createLocalTeamsHost({ ...service.configuration, maxActivityBytes: 2_048 }, { application: mock.application, ports: mock.ports });
  const post = () => fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(service.activity()) });
  try {
    await host.start(); await post(); await mock.closed;
    assert.equal(service.writes.length, outcome === "revoked" ? 2 : 3);
    assert.ok(service.writes.every((write) => Buffer.byteLength(JSON.stringify(write.body)) <= 2_048));
    const saved = await mock.ports.records.read(service.mapping.actor, "case-1"); assert.ok(saved?.scope === "full");
    const children = saved.deliveries.filter((item) => item.deliveryKey === "case-1:report:1");
    assert.deepEqual(children.map((item) => item.status), ["delivered", outcome === "revoked" ? "failed" : "unknown"]);
    assert.equal(saved.audits.filter((entry) => entry.action === "delivery.send" && entry.stage === "intent").length, 2);
    const writes = service.writes.length; assert.equal((await (await post()).json() as { status: string }).status, "duplicate"); assert.equal(service.writes.length, writes);
  } finally { await host.stop(); await service.close(); }
});

for (const outcome of ["resource", "user"] as const) test(`a ${outcome} grant revoked while native outbound token acquisition waits is checked before any report bytes`, async () => {
  const service = await teamsServices(); const deny: string[] = [];
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let report = false, count = 0;
  const mock = createMockTroubleshooting({ denyActions: deny, model: async (_context, draft) => { report = true; return { candidate: draft, actualMicrousd: 1_000 }; } });
  const token = service.configuration.token;
  const host = await createLocalTeamsHost({ ...service.configuration, token: async () => { if (report && ++count === 1) { held.resolve(); await release.promise; } return token(); } }, { application: mock.application, ports: mock.ports });
  try {
    await host.start(); await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(service.activity()) });
    await held.promise;
    if (outcome === "resource") deny.push("delivery.send"); else service.setTokenMode("revoked");
    release.resolve(); await mock.closed;
    assert.equal(service.writes.length, 1);
    const saved = await mock.ports.records.read(service.mapping.actor, "case-1"); assert.ok(saved?.scope === "full");
    assert.equal(saved.deliveries.find((item) => item.deliveryKey.endsWith(":report:1"))!.status, "failed");
  } finally { release.resolve(); await host.stop(); await service.close(); }
});

test("actual exact-limit JSON is accepted while chunked overflow, malformed UTF-8 and compression fail before authentication", async () => {
  const { request } = await import("node:http");
  const service = await teamsServices(); const mock = createMockTroubleshooting();
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  const raw = (chunks: readonly Buffer[], encoding?: string) => new Promise<number>((resolve, reject) => {
    const req = request(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}`, ...(encoding ? { "content-encoding": encoding } : {}) } }, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
    req.on("error", reject); for (const chunk of chunks) req.write(chunk); req.end();
  });
  try {
    await host.start(); const body = JSON.stringify(service.activity());
    assert.equal(await raw([Buffer.from(body + " ".repeat(65_536 - Buffer.byteLength(body)))]), 200); await mock.closed;
    const before = service.tokenRequests(), writes = service.writes.length;
    assert.equal(await raw([Buffer.from("{"), Buffer.alloc(65_536, "x")]), 413);
    assert.equal(await raw([Buffer.from([0xc3, 0x28])]), 400);
    assert.equal(await raw([Buffer.from(body)], "gzip"), 415);
    assert.equal(service.tokenRequests(), before); assert.equal(service.writes.length, writes);
  } finally { await host.stop(); await service.close(); }
});

test("D caps sockets before headers instead of retaining an unlimited pre-parse connection queue", async () => {
  const { createConnection } = await import("node:net");
  const service = await teamsServices(); const mock = createMockTroubleshooting(); const sockets: import("node:net").Socket[] = [];
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  try {
    await host.start(); const port = Number(new URL(host.url).port);
    for (let count = 0; count < 32; count++) { const socket = createConnection({ host: "127.0.0.1", port }); sockets.push(socket); await once(socket, "connect"); }
    const overflow = createConnection({ host: "127.0.0.1", port }); sockets.push(overflow);
    overflow.on("error", () => {}); overflow.resume(); const closed = new Promise<void>((resolve) => overflow.once("close", () => resolve()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("unbounded_preparse_socket")), 100); })]); }
    finally { clearTimeout(timer); }
    assert.equal(mock.events.length, 0);
  } finally { for (const socket of sockets) socket.destroy(); await host.stop(); await service.close(); }
});

test("incoming byte progress cannot extend the absolute pre-parse read deadline", async () => {
  const { createConnection } = await import("node:net"); const { ManualClock } = await import("../fixtures/clock.js");
  const clock = new ManualClock(); const service = await teamsServices(); const mock = createMockTroubleshooting({ clock });
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  let socket: import("node:net").Socket | undefined;
  try {
    await host.start(); socket = createConnection({ host: "127.0.0.1", port: Number(new URL(host.url).port) }); socket.on("error", () => {}); await once(socket, "connect"); socket.resume();
    const closed = new Promise<void>((resolve) => socket!.once("close", () => resolve()));
    socket.write("POST /api/messages HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{");
    await new Promise(setImmediate); clock.advance(4_999); socket.write(" "); await new Promise(setImmediate); clock.advance(1);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("raw_read_deadline_reset")), 100); })]); }
    finally { clearTimeout(timer); }
    assert.equal(service.tokenRequests(), 0); assert.equal(mock.events.length, 0);
  } finally { socket?.destroy(); await host.stop(); await service.close(); }
});

test("native activity receipt IDs from different fixed private conversations cannot overwrite another case's reply binding", async () => {
  const service = await teamsServices(); service.setReceiptId("same-local-id");
  const second = { ...service.mapping, oid: "synthetic-oid-2", userId: "synthetic-user-2", conversationId: "synthetic-conversation-2",
    actor: { ...service.mapping.actor, principalRef: "principal-2", destinationRef: "private-conversation-2" } };
  const mock = createMockTroubleshooting({ authorizedActors: [service.mapping.actor, second.actor], customerCandidates: [
    { applicationId: "SYNTHETIC-SECRET-APPLICATION", submittedAt: "2026-10-18T10:00:00.000Z" },
    { applicationId: "other-application", submittedAt: "2026-10-19T10:00:00.000Z" },
  ] });
  const host = await createLocalTeamsHost({ ...service.configuration, mappings: [service.mapping, second] }, { application: mock.application, ports: mock.ports });
  const post = (body: unknown) => fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(body) });
  try {
    await host.start();
    const first = service.activity(JSON.stringify({ action: "investigate", customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" }));
    await post(first); await mock.phaseClosed(1, "case-1");
    await post({ ...first, id: "other-event", from: { id: second.userId, aadObjectId: second.oid }, conversation: { ...first.conversation, id: second.conversationId } }); await mock.phaseClosed(1, "case-2");
    const reply = { ...service.activity(JSON.stringify({ action: "provide_information", caseRef: "case-1", questionId: "case-1:question:1", content: { submittedAt: "2026-10-18T10:00:00.000Z" } })), id: "reply-old-conversation", replyToId: "same-local-id" };
    assert.deepEqual(await (await post(reply)).json(), { status: "resumed", caseRef: "case-1", phaseId: 2 });
    await mock.phaseClosed(2, "case-1");
  } finally { await host.stop(); await service.close(); }
});

test("the local Teams bootstrap refuses a native Node -r preload before opening any traffic surface", async () => {
  const { spawnSync } = await import("node:child_process");
  const module = new URL("../../src/adapters/teams/host.js", import.meta.url).href;
  const program = `const {createLocalTeamsHost}=await import(${JSON.stringify(module)});
    const config={profile:'local_protocol',clientId:'synthetic-app',tenantId:'synthetic-tenant',botId:'synthetic-bot',serviceUrl:'http://127.0.0.1:1',tokenUrl:'http://127.0.0.1:1',serviceMetadataUrl:'http://127.0.0.1:1/.well-known/openidconfiguration',user:{audience:'synthetic-user-app',issuer:'https://identity.synthetic.invalid/tenant/v2.0',jwksUrl:'http://127.0.0.1:1/.well-known/keys',connectionName:'synthetic-identity'},mappings:[],token:async()=>''};
    try {const host=await createLocalTeamsHost(config,{application:{close:async()=>{}},ports:{clock:{now:()=>0,utc:()=> '2026-10-19T09:00:00.000Z'},delivery:{}}});await host.stop();console.log('allowed');}catch(error){console.log(error.message);}`;
  const result = spawnSync(process.execPath, ["-r", "node:fs", "--input-type=module", "-e", program], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" }, timeout: 3_000 });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), "contract_unverified");
});

for (const outcome of ["malformed", "missing-id", "429"]) test(`native ${outcome} acknowledgement never becomes delivery proof or triggers another POST`, async () => {
  const service = await teamsServices(); const mock = createMockTroubleshooting({ model: async (_context, draft) => { service.setWriteMode(outcome); return { candidate: draft, actualMicrousd: 1_000 }; } });
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  try {
    await host.start(); await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(service.activity()) });
    await mock.closed; assert.equal(service.writes.length, 2);
    const saved = await mock.ports.records.read(service.mapping.actor, "case-1"); assert.ok(saved?.scope === "full");
    assert.equal(saved.view.deliveryStatus, "unknown"); assert.equal(saved.deliveries.find((item) => item.deliveryKey.endsWith(":report:1"))!.status, "unknown");
  } finally { await host.stop(); await service.close(); }
});

test("a failed sanitizer cleanup cannot prevent shutdown from aborting the other active cases", async () => {
  const { ManualClock } = await import("../fixtures/clock.js"); const clock = new ManualClock();
  const service = await teamsServices(); const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const aborted = new Set<string>(); let active = 0;
  const mock = createMockTroubleshooting({ clock, agent: async (context) => {
    if (++active === 2) started.resolve();
    context.signal.addEventListener("abort", () => aborted.add(context.caseRef), { once: true });
    await release.promise; return {};
  } });
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  const clear = mock.ports.sanitization.clear;
  try {
    await host.start(); await mock.receive(); await mock.receive({ eventRef: "second-event" }); await started.promise;
    mock.ports.sanitization.clear = (caseRef) => { if (caseRef === "case-1") throw new Error("SYNTHETIC-SECRET-cleanup"); clear(caseRef); };
    const stopping = host.stop(); await new Promise(setImmediate); clock.advance(5_000);
    assert.equal(await stopping, "unknown");
    assert.deepEqual([...aborted].sort(), ["case-1", "case-2"]);
    assert.equal((await mock.receive({ eventRef: "after-failed-cleanup" })).status, "service_unavailable");
    assert.equal(service.writes.length, 2, "only the two accepted statuses were sent");
  } finally { mock.ports.sanitization.clear = clear; release.resolve(); await host.stop(); await service.close(); }
});

test("a host identity-denial audit failure closes admission and aborts existing work without a report", async () => {
  const service = await teamsServices(); const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const mock = createMockTroubleshooting({ agent: async (context) => { started.resolve(); context.signal.addEventListener("abort", () => release.resolve(), { once: true }); await release.promise; return {}; } });
  const complete = mock.ports.audit.complete;
  mock.ports.audit.complete = async (context, action, outcome, details) => {
    if (action === "authorization.denied") throw new Error("SYNTHETIC-SECRET-audit-path");
    await complete(context, action, outcome, details);
  };
  const host = await createLocalTeamsHost(service.configuration, { application: mock.application, ports: mock.ports });
  const post = () => fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(service.activity()) }).catch(() => null);
  try {
    await host.start(); await post(); await started.promise; service.setTokenMode("wrong-scope"); await post();
    assert.equal((await mock.receive({ eventRef: "after-host-audit-loss" })).status, "service_unavailable");
    assert.equal(await host.stop(), "closed");
    assert.equal(service.writes.length, 1);
    assert.equal(mock.events.some((event) => ["logs.read", "model.generate"].includes(event.action)), false);
  } finally { release.resolve(); await host.stop(); await service.close(); }
});

test("a restored SQLite query cannot disclose case metadata after application close during its final resource authorization", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { SqliteRecords } = await import("../../src/adapters/records/sqlite.js");
  const directory = await mkdtemp(join(tmpdir(), "bau-teams-query-close-"));
  const service = await teamsServices(); const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let store: InstanceType<typeof SqliteRecords> | undefined, host: Awaited<ReturnType<typeof createLocalTeamsHost>> | undefined;
  const controls = (ports: ReturnType<typeof createMockTroubleshooting>["ports"]) => { store = new SqliteRecords(directory, ports); return { records: store.records, audit: store.audit, admission: store.admission, budget: store.budget, retention: store.retention }; };
  const post = (body: unknown) => fetch(host!.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken()}` }, body: JSON.stringify(body) });
  try {
    const first = createMockTroubleshooting({ controlPorts: controls });
    host = await createLocalTeamsHost(service.configuration, { application: first.application, ports: first.ports }); await host.start();
    assert.equal((await (await post(service.activity())).json() as { status: string }).status, "accepted"); await first.closed;
    assert.equal(await host.stop(), "closed"); store!.close();
    const restored = createMockTroubleshooting({ controlPorts: controls });
    host = await createLocalTeamsHost(service.configuration, { application: restored.application, ports: restored.ports }); await host.start();
    const allows = restored.ports.authorization.allows; let reads = 0;
    restored.ports.authorization.allows = async (action, context) => { if (action === "records.read" && ++reads === 2) { held.resolve(); await release.promise; } return allows(action, context); };
    const querying = post({ ...service.activity(JSON.stringify({ action: "get", caseRef: "case-1" })), id: "restored-query-close" });
    await held.promise; await restored.application.close(); release.resolve();
    assert.deepEqual(await (await querying).json(), { status: "denied" });
    assert.deepEqual(await restored.application.get(service.mapping.actor, "case-1"), { status: "denied" });
    assert.equal(service.writes.length, 2, "closing and restored queries never send another status or report");
    assert.equal(await host.stop(), "closed");
  } finally { release.resolve(); await host?.stop(); store?.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
