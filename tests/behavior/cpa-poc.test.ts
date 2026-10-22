import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { createResponsesGateway, cpaPocModelPolicy } from "../../src/adapters/model/responses.js";
import { responsesServer, textEvents } from "../fixtures/responses.js";

test("CPA synthetic POC observes output beyond 4k without treating token usage or synthetic fields as a fee", async () => {
  const server = await responsesServer((_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of textEvents("x".repeat(10_000), {
    input_tokens: 123, output_tokens: 5_000, output_tokens_details: { reasoning_tokens: 100 },
    synthetic_source: "mock_usage", synthetic_cost_microusd: 0,
    })) {
      if ("response" in event) Object.assign(event.response, { model: "gpt-6.1-sol" });
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
  });
  try {
    const gateway = createResponsesGateway({ route: "cpa", baseUrl: server.baseUrl, contract: "cpa-poc-output-observation-1", apiKey: "synthetic-client-key" });
    let envelope: unknown;
    const response = await gateway.generate({ tenantRef: "tenant-1", principalRef: "principal-1", destinationRef: "private-conversation-1",
      caseRef: "case-1", phaseId: 1, callId: "call-1", resourceRefs: ["simulator-source"], policyVersion: "mock-policy-1", approvalRef: "mock-approval-1",
      snapshotRef: "simulator-snapshot-1", budgetRef: "case-1", deadline: 60_000, signal: new AbortController().signal },
    { schemaVersion: 1, messages: [{ role: "system", content: "Synthetic only." }, { role: "user", content: "Synthetic output observation." }] },
    async (prepared) => { envelope = prepared; });
    assert.equal(response.message.content[0]?.type === "text" && response.message.content[0].text.length, 10_000);
    assert.equal(response.actualMicrousd, null);
    assert.equal(response.usageSource, "unknown");
    assert.deepEqual(response.tokenUsage, { source: "upstream_tokens", inputTokens: 123, outputTokens: 5_000, reasoningTokens: 100, cachedInputTokens: null });
    assert.equal((envelope as { maxOutputTokens: unknown }).maxOutputTokens, null);
    assert.equal(JSON.parse(server.requests[0]!).model, "gpt-6.1-sol");
    assert.equal(Object.hasOwn(JSON.parse(server.requests[0]!), "max_output_tokens"), false);
  } finally { await server.close(); }
});

test("an admitted CPA POC attempt keeps its unknown fee reservation while releasing ended execution and retaining measured output", async () => {
  const server = await responsesServer((_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of textEvents("x".repeat(10_000), { input_tokens: 123, output_tokens: 5_000 })) {
      if ("response" in event) Object.assign(event.response, { model: "gpt-6.1-sol" });
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
  });
  const mock = createMockTroubleshooting({ modelProfile: "cpa_poc", modelPolicy: cpaPocModelPolicy, agent: async (_context, request) => {
    await request.generate({ schemaVersion: 1, messages: [{ role: "system", content: "Synthetic only." }, { role: "user", content: "Observe output." }] });
    await request.invoke("logs.read", null); await request.invoke("code.search", null); return request.diagnose();
  } });
  mock.ports.model.generate = createResponsesGateway({ route: "cpa", baseUrl: server.baseUrl, contract: cpaPocModelPolicy.protocol,
    apiKey: "synthetic-client-key", clock: mock.ports.clock }).generate;
  try {
    await mock.receive(); await mock.closed;
    const saved = await mock.ports.records.export(mock.inbound, "case-1");
    assert.ok(saved?.scope === "full"); assert.equal(saved.view.state, "completed");
    const status = await mock.ports.budget.status("case-1");
    assert.equal(status.attempts, 1); assert.equal(status.unsettledCalls, 0); assert.equal(status.reservedMicrousd, 180_000);
    assert.equal(status.charges[0]?.actualMicrousd, null); assert.equal(status.charges[0]?.source, "unknown");
    assert.ok(saved.records.some((record) => record.kind === "model_output" && JSON.stringify(record.payload).includes('"outputTokens":5000')));
    assert.ok(saved.audits.some((audit) => audit.action === "model.generate" && (audit.model as { profile: string }).profile === "cpa_poc"));
    assert.equal(JSON.stringify(saved).includes("synthetic-client-key"), false);
  } finally { await server.close(); await mock.application.close(); }
});

test("CPA POC output observation cannot bypass authorization, input admission, or policy binding", async () => {
  const server = await responsesServer((_body, response) => { response.writeHead(500); response.end(); });
  try {
    for (const fault of ["denied", "oversized", "unsafe", "wrong-policy"] as const) {
      const mock = createMockTroubleshooting({ modelProfile: "cpa_poc", modelPolicy: fault === "wrong-policy" ? { ...cpaPocModelPolicy, hiddenAttempts: 1 } : cpaPocModelPolicy,
        ...(fault === "denied" ? { denyActions: ["model.generate"] } : {}), agent: async (_context, request) => request.generate({ schemaVersion: 1,
          messages: [{ role: "system", content: "Synthetic only." }, { role: "user", content: fault === "oversized" ? "x".repeat(24_000)
            : fault === "unsafe" ? "SYNTHETIC-SECRET-MODEL-INPUT" : "Synthetic probe." }] }) });
      mock.ports.model.generate = createResponsesGateway({ route: "cpa", baseUrl: server.baseUrl, contract: cpaPocModelPolicy.protocol,
        apiKey: "synthetic-client-key", clock: mock.ports.clock }).generate;
      try {
        await mock.receive(); await mock.closed;
        assert.equal(server.requests.length, 0, fault);
        assert.equal((await mock.ports.budget.status("case-1")).attempts, 0, fault);
        assert.equal(mock.events.some((event) => event.action === "delivery.send"), false, fault);
      } finally { await mock.application.close(); }
    }
    for (const options of [{ route: "cpa" as const, baseUrl: server.baseUrl }, { route: "company" as const, baseUrl: server.baseUrl },
      { route: "cpa" as const, baseUrl: "https://example.invalid/v1" }]) {
      assert.throws(() => createResponsesGateway({ ...options, contract: cpaPocModelPolicy.protocol }), /contract_unverified/);
    }
  } finally { await server.close(); }
});

test("upstream input usage exceeding 24k stops a CPA case without delivering a report or releasing its unknown fee", async () => {
  const server = await responsesServer((_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of textEvents("Safe synthetic reply.", { input_tokens: 24_001, output_tokens: 10 })) {
      if ("response" in event) Object.assign(event.response, { model: "gpt-6.1-sol" });
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
  });
  const mock = createMockTroubleshooting({ modelProfile: "cpa_poc", modelPolicy: cpaPocModelPolicy, agent: async (_context, request) => {
    await request.generate({ schemaVersion: 1, messages: [{ role: "system", content: "Synthetic only." }, { role: "user", content: "Synthetic probe." }] });
    await request.invoke("logs.read", null); await request.invoke("code.search", null); return request.diagnose();
  } });
  mock.ports.model.generate = createResponsesGateway({ route: "cpa", baseUrl: server.baseUrl, contract: cpaPocModelPolicy.protocol,
    apiKey: "synthetic-client-key", clock: mock.ports.clock }).generate;
  try {
    await mock.receive(); await mock.closed;
    const view = await mock.application.get(mock.inbound, "case-1");
    assert.ok("state" in view && view.state === "stopped" && view.stopReason === "budget_exhausted");
    assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
    const budget = await mock.ports.budget.status("case-1"); assert.equal(budget.reservedMicrousd, 180_000); assert.equal(budget.unsettledCalls, 0);
  } finally { await server.close(); await mock.application.close(); }
});
