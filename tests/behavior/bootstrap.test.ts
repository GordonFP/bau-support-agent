import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMockRuntime } from "../../src/bootstrap/runtime.js";
import { ManualClock } from "../fixtures/clock.js";

test("the packaged Mock composition persists A–D Simulator evidence and deduplicates after a confirmed close and reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-bootstrap-"));
  let runtime: Awaited<ReturnType<typeof openMockRuntime>> | undefined;
  try {
    runtime = await openMockRuntime({ schemaVersion: 1, profile: "mock", recordsDirectory: directory });
    assert.equal((await runtime.receive()).status, "accepted"); await runtime.closed;
    const delivered = await runtime.delivery.next();
    assert.ok(delivered.report.scene === "simulator");
    assert.deepEqual(delivered.report.simulator.dataReadiness, { satisfied: 9, missing: 1, unknown: 0 });
    const before = await runtime.ports.budget.status("case-1");
    const retained = await runtime.ports.records.export(runtime.inbound, "case-1");
    assert.ok(retained?.scope === "full" && retained.records.some((record) => record.kind === "report"));
    assert.equal(await runtime.close(), "closed");
    runtime = await openMockRuntime({ schemaVersion: 1, profile: "mock", recordsDirectory: directory });
    assert.equal((await runtime.receive()).status, "duplicate");
    assert.equal(runtime.events.some((event) => ["logs.read", "model.generate", "delivery.send"].includes(event.action)), false);
    assert.deepEqual(await runtime.ports.budget.status("case-1"), before);
  } finally { await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("unknown host shutdown shares one five-second wait and holds the original SQLite owner until the original B work settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-bootstrap-close-"));
  const clock = new ManualClock(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const config = { schemaVersion: 1, profile: "mock", recordsDirectory: directory };
  const runtime = await openMockRuntime(config, { mocks: { clock, agent: async (_context, request) => {
    entered.resolve(); await release.promise; return request.generate(request.diagnose());
  } } });
  try {
    await runtime.receive(); await entered.promise;
    const stopping = runtime.close(); await new Promise(setImmediate); clock.advance(5000);
    assert.equal(await stopping, "unknown"); assert.equal(await runtime.close(), "unknown");
    assert.equal((await runtime.receive({ eventRef: "late" })).status, "service_unavailable");
    await assert.rejects(openMockRuntime(config), /^Error: runtime_unavailable$/);
    release.resolve(); await runtime.closed; await new Promise(setImmediate);
    assert.equal(await runtime.close(), "closed");
    const restarted = await openMockRuntime(config);
    try {
      const view = await restarted.application.get(restarted.inbound, "case-1");
      assert.ok("state" in view); assert.equal(view.state, "stopped"); assert.equal(view.stopReason, "interrupted");
      assert.equal((await restarted.receive()).status, "duplicate");
      assert.equal(restarted.events.some((event) => ["logs.read", "model.generate", "delivery.send"].includes(event.action)), false);
    } finally { await restarted.close(); }
  } finally { release.resolve(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a required store or startup audit failure exposes no runnable Mock and releases only its own failed startup lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-bootstrap-storage-"));
  const config = { schemaVersion: 1, profile: "mock", recordsDirectory: directory };
  try {
    await assert.rejects(openMockRuntime({ ...config, recordsDirectory: join(directory, "missing") }), /^Error: runtime_unavailable$/);
    await assert.rejects(openMockRuntime(config, { storeFault: (point) => { if (point === "audit:runtime.start:intent") throw new Error("synthetic-write-failure"); } }), /^Error: runtime_unavailable$/);
    const runtime = await openMockRuntime(config); assert.equal(await runtime.close(), "closed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("artifact-checked Mock readiness lists separate unmet real gates and configuration assertions cannot enable them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-bootstrap-gates-"));
  const config = { schemaVersion: 1, profile: "mock", recordsDirectory: directory };
  const runtime = await openMockRuntime(config);
  try {
    assert.equal(runtime.gates.mock.state, "ready");
    assert.equal(runtime.gates.artifacts.node, "24.22.0");
    assert.equal(runtime.gates.artifacts.skillSha256, "e204643dabd38e47d884b5aee74846b060e18fee46a50b3a6ddfd336f3d16a69");
    for (const name of ["cpa", "company", "teams", "logs", "code", "groups", "backups", "evaluation"] as const) {
      assert.equal(runtime.gates[name].state, "disabled"); assert.ok(runtime.gates[name].missing.length > 0);
    }
  } finally { await runtime.close(); }
  try {
    for (const invalid of [{ ...config, verified: true }, { ...config, profile: "company" }, { ...config, url: "https://unapproved.invalid" },
      { ...config, credential: "synthetic-unapproved" }, { ...config, replicas: 2 }]) await assert.rejects(openMockRuntime(invalid), /^Error: runtime_unavailable$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the same persistent Mock bootstrap supports the final PSP contract without treating unsupported second checks as executed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-bootstrap-psp-"));
  const runtime = await openMockRuntime({ schemaVersion: 1, profile: "mock", recordsDirectory: directory });
  try {
    assert.equal((await runtime.receive({ input: { scenario: "psp", applicationId: "SYNTHETIC-SECRET-APPLICATION",
      shopId: "SYNTHETIC-SECRET-SHOP", bindingId: "SYNTHETIC-SECRET-BINDING", question: "Why is this shop controlled?" } })).status, "accepted");
    await runtime.closed;
    const report = (await runtime.delivery.next()).report;
    assert.ok(report.scene === "psp");
    assert.equal(report.psp.support.status, "unsupported");
    assert.equal(report.psp.second.status, "not_applicable");
    assert.equal(report.psp.approval, "unknown"); assert.equal(report.psp.amount, null);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
