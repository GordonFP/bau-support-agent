import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting, type MockOptions } from "../../src/adapters/mock/troubleshooting.js";
import { createResponsesGateway, cpaPocModelPolicy } from "../../src/adapters/model/responses.js";
import { postmanSimulation } from "../fixtures/postman-simulation.js";
import { syntheticCpaCore } from "../fixtures/cpa-core.js";
import { ManualClock } from "../fixtures/clock.js";
import { responsesServer } from "../fixtures/responses.js";
import type { ModelTurn } from "../../src/troubleshooting/application/model-contract.js";
import { validateModelEnvelope } from "../../src/troubleshooting/application/model-envelope.js";

const syntheticTurn = (padding = 0): ModelTurn => ({ schemaVersion: 1, messages: [
  { role: "system", content: "Synthetic only.", toolsAdded: ["logs_read", "code_search"].map((name) => ({
    name: name as "logs_read" | "code_search", description: "Approved synthetic tool.", parameters: { type: "object", properties: {}, additionalProperties: false } })) },
  { role: "user", content: "Synthetic input " + "x".repeat(padding) },
] });

test("actual CPA 8.0.38 synthetic upstream validates application deadlines, rate, concurrency and retries", { timeout: 60_000 }, async (t) => {
  assert.ok(process.env.POSTMAN_CLI); assert.ok(process.env.BAU_CPA_TEST_BINARY);
  const simulation = await postmanSimulation(process.env.POSTMAN_CLI, "postman/simulations/cpa-core.sim.yaml", "/codex");
  let core: Awaited<ReturnType<typeof syntheticCpaCore>>;
  // A 503 deliberately cools its synthetic credential. Each scenario owns a
  // fresh core so that failure does not silently select a different credential.
  const scenario = (name: string, run: () => Promise<void>) => t.test(name, async () => {
    core = await syntheticCpaCore(process.env.BAU_CPA_TEST_BINARY!, `${simulation.baseUrl}/v1`);
    try { await run(); } finally { await release(); await core.close(); }
  });
  const state = async () => await (await fetch(`${simulation.baseUrl}/__state`)).json() as { starts: number; active: number; maxActive: number; cancelled: number };
  const release = async () => { await fetch(`${simulation.baseUrl}/__release`, { method: "POST" }); };
  const until = async (ready: () => Promise<boolean>) => {
    const deadline = performance.now() + 3_000;
    while (!await ready()) { if (performance.now() >= deadline) throw new Error("fixture_observation_timeout"); await new Promise((done) => setTimeout(done, 10)); }
  };
  const mockCase = (options: MockOptions = {}, baseUrl = core.baseUrl) => {
    const mock = createMockTroubleshooting({ ...options, modelProfile: "cpa_poc", modelPolicy: cpaPocModelPolicy });
    mock.ports.model.generate = createResponsesGateway({ route: "cpa", contract: cpaPocModelPolicy.protocol, baseUrl, apiKey: core.apiKey, clock: mock.ports.clock,
      pricingDatabase: "/nonexistent/synthetic-price.sqlite" }).generate;
    return mock;
  };
  try {
    await scenario("60-second local deadline and cancellation retain unknown fees without late delivery", async () => {
      for (const mode of ["timeout", "cancel"] as const) {
        const before = await state(); const clock = new ManualClock(); const mock = mockCase({ clock });
        try {
          await mock.receive({ input: { applicationId: "SYNTHETIC-SECRET-APPLICATION", question: "native-delay synthetic probe" } });
          await until(async () => (await state()).starts === before.starts + 1);
          if (mode === "timeout") clock.advance(60_000); else await mock.application.cancel(mock.inbound, "case-1");
          await mock.closed;
          const view = await mock.application.get(mock.inbound, "case-1");
          assert.ok("state" in view && view.state === "stopped" && view.stopReason === (mode === "timeout" ? "timeout" : "cancelled"));
          const budget = await mock.ports.budget.status("case-1"); assert.equal(budget.reservedMicrousd, 180_000); assert.equal(budget.charges[0]?.actualMicrousd, null);
          assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
          await release(); await until(async () => (await state()).active === 0);
          assert.deepEqual(await mock.application.get(mock.inbound, "case-1"), view);
        } finally { await release(); await mock.application.close(); }
      }
    });
    await scenario("at most two unsettled native requests start while a third waits and resumes after terminal completion", async () => {
      const before = await state(); const mock = mockCase();
      try {
        for (let i = 0; i < 3; i++) await mock.receive({ eventRef: `parallel-${i}`, input: { applicationId: "SYNTHETIC-SECRET-APPLICATION", question: "native-delay synthetic probe" } });
        await until(async () => (await state()).active === 2);
        assert.equal((await state()).starts - before.starts, 2);
        await release(); await mock.phaseClosed(1, "case-1"); await mock.phaseClosed(1, "case-2");
        await until(async () => (await state()).starts === before.starts + 3); await release(); await mock.phaseClosed(1, "case-3");
        assert.equal((await state()).maxActive, 2);
        for (const id of ["case-1", "case-2", "case-3"]) { const view = await mock.application.get(mock.inbound, id); assert.ok("state" in view && view.state === "completed"); }
      } finally { await release(); await mock.application.close(); }
    });
    await scenario("a proxy 503 makes one upstream attempt with all automatic proxy and SDK retries disabled", async () => {
      const before = await state(); const mock = mockCase();
      try {
        await mock.receive({ input: { applicationId: "SYNTHETIC-SECRET-APPLICATION", question: "native-503 synthetic probe" } }); await mock.closed;
        assert.equal((await state()).starts - before.starts, 1);
        assert.equal((await mock.ports.budget.status("case-1")).attempts, 1);
        assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
      } finally { await mock.application.close(); }
    });
    await scenario("one application network retry reaches real CPA while the original unknown charge remains", async () => {
      const before = await state(); let requests = 0;
      const bridge = await responsesServer(async (body, response) => {
        if (++requests === 1) { response.destroy(); return; }
        const upstream = await fetch(`${core.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${core.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) });
        response.writeHead(upstream.status, { "content-type": "text/event-stream" });
        if (!upstream.body) { response.end(); return; }
        for await (const chunk of upstream.body) response.write(chunk);
        response.end();
      });
      const mock = mockCase({}, bridge.baseUrl);
      try {
        await mock.receive(); await mock.closed;
        assert.equal(requests, 2); assert.equal((await state()).starts - before.starts, 1);
        const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view && view.state === "completed");
        const budget = await mock.ports.budget.status("case-1"); assert.equal(budget.attempts, 2); assert.equal(budget.reservedMicrousd, 360_000); assert.equal(budget.unsettledCalls, 1);
      } finally { await bridge.close(); await mock.application.close(); }
    });
    await scenario("six physical attempts share one case ledger and the seventh makes no native request", async () => {
      const before = await state(); const mock = mockCase({ agent: async (_context, request) => {
        await request.invoke("logs.read", null); await request.invoke("code.search", null);
        for (let i = 0; i < 7; i++) await request.generate(syntheticTurn());
        return request.diagnose();
      } });
      try {
        await mock.receive(); await mock.closed; assert.equal((await state()).starts - before.starts, 6);
        const budget = await mock.ports.budget.status("case-1"); assert.equal(budget.attempts, 6); assert.equal(budget.startsLast60s, 6);
        const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view && view.stopReason === "budget_exhausted");
      } finally { await mock.application.close(); }
    });
    await scenario("six starts per rolling minute delay the seventh case until the exact window expires", async () => {
      const before = await state(); const clock = new ManualClock(); const mock = mockCase({ clock });
      try {
        for (let i = 1; i <= 6; i++) {
          await mock.receive({ eventRef: `rate-${i}` }); await mock.phaseClosed(1, `case-${i}`);
        }
        clock.advance(1_000);
        await mock.receive({ eventRef: "rate-7" });
        await until(async () => !!(await mock.ports.records.read(mock.inbound, "case-7"))?.records.some((record) => record.kind === "model_input"));
        assert.equal((await state()).starts - before.starts, 6);
        assert.equal((await mock.ports.budget.status("case-7")).attempts, 0);
        clock.advance(58_999); await new Promise((done) => setImmediate(done));
        assert.equal((await state()).starts - before.starts, 6);
        clock.advance(1); await mock.phaseClosed(1, "case-7");
        assert.equal((await state()).starts - before.starts, 7);
        assert.equal((await mock.ports.budget.status("case-7")).attempts, 1);
      } finally { await mock.application.close(); }
    });
    await scenario("exact local 24k admission reaches native CPA and the next byte causes zero extra HTTP", async () => {
      const before = await state(); const mock = mockCase();
      const gateway = createResponsesGateway({ route: "cpa", contract: cpaPocModelPolicy.protocol, baseUrl: core.baseUrl, apiKey: core.apiKey });
      const context = { ...mock.inbound, caseRef: "case-boundary", phaseId: 1, callId: "boundary-1", resourceRefs: ["simulator-source"],
        policyVersion: "mock-policy-1", approvalRef: "mock-approval-1", snapshotRef: "simulator-snapshot-1", budgetRef: "case-boundary", deadline: 60_000, signal: new AbortController().signal };
      try {
        let overhead = 0;
        await assert.rejects(gateway.generate(context, syntheticTurn(), async (prepared) => { overhead = prepared.inputTokensUpperBound; throw new Error("contract_unverified"); }), /contract_unverified/);
        assert.ok(overhead > 2_048 && overhead < 24_000);
        for (const extra of [0, 1]) {
          const turn = syntheticTurn(24_000 - overhead + extra);
          const pending = gateway.generate(context, turn, async (prepared) => {
            assert.equal(prepared.inputTokensUpperBound, 24_000 + extra);
            validateModelEnvelope(turn, prepared, cpaPocModelPolicy);
          });
          if (extra) await assert.rejects(pending, /budget_exhausted/); else await pending;
        }
        assert.equal((await state()).starts - before.starts, 1);
      } finally { await mock.application.close(); }
    });
    await scenario("the 180-second phase deadline stops another call even when each previous call completed", async () => {
      const before = await state(); const clock = new ManualClock(); const mock = mockCase({ clock, agent: async (_context, request) => {
        await request.invoke("logs.read", null); await request.invoke("code.search", null);
        for (let i = 0; i < 4; i++) { clock.advance(50_000); await request.generate(request.diagnose()); }
        return request.diagnose();
      } });
      try {
        await mock.receive(); await mock.closed; assert.equal((await state()).starts - before.starts, 3);
        const view = await mock.application.get(mock.inbound, "case-1"); assert.ok("state" in view && view.stopReason === "timeout");
      } finally { await mock.application.close(); }
    });
  } finally { await release(); await simulation.close(); }
});
