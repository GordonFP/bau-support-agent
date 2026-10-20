import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { createResponsesGateway, responsesModelPolicy } from "../../src/adapters/model/responses.js";
import { postmanResponses } from "../fixtures/postman-responses.js";
import { modelDrivenSimulator } from "../fixtures/model-driver.js";

test("actual A/B/C gateway completes model-selected log/code tool turns through the reviewed Postman Responses simulation", { timeout: 20_000 }, async () => {
  assert.ok(process.env.POSTMAN_CLI, "Set POSTMAN_CLI to the reviewed local CLI1.74 executable.");
  const simulation = await postmanResponses(process.env.POSTMAN_CLI);
  const mock = createMockTroubleshooting({ agent: modelDrivenSimulator, modelPolicy: responsesModelPolicy, modelProfile: "local_protocol" });
  mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", baseUrl: simulation.baseUrl, contract: responsesModelPolicy.protocol, clock: mock.ports.clock }).generate;
  try {
    await mock.receive(); await mock.closed;
    const stored = await mock.ports.records.export(mock.inbound, "case-1");
    assert.ok(stored?.scope === "full");
    assert.equal(stored.view.state, "completed");
    const report = await mock.delivery.next();
    assert.ok(report.report.scene === "simulator");
    assert.equal(report.report.simulator.shopCount, 10);
    assert.deepEqual(report.report.simulator.dataReadiness, { satisfied: 9, missing: 1, unknown: 0 });
    const budget = await mock.ports.budget.status("case-1");
    assert.equal(budget.attempts, 3);
    assert.equal(budget.reservedMicrousd, 3_000);
    assert.equal(budget.unsettledCalls, 0);
    const inputs = stored.records.filter((record) => record.kind === "model_input").map((record) => JSON.parse((record.payload as { canonicalInput: string }).canonicalInput) as unknown);
    await simulation.waitForRequests(3);
    const requests = simulation.requests();
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map((request) => request.requestBody), inputs);
    assert.ok(stored.audits.filter((audit) => audit.action === "model.generate").every((audit) =>
      (audit.model as { profile?: string })?.profile === "local_protocol"));
    const exits = mock.events.filter((event) => event.action.startsWith("audit:") || event.action.startsWith("model.") || event.action.startsWith("delivery."));
    assert.equal(JSON.stringify({ stored, exits, logs: simulation.logs(), report }).includes("SYNTHETIC-SECRET"), false);
  } finally { await simulation.close(); }
});

test("the local upstream enforces its 4k total-generation definition before emitting, independently of the requested max field", { timeout: 20_000 }, async () => {
  assert.ok(process.env.POSTMAN_CLI);
  const simulation = await postmanResponses(process.env.POSTMAN_CLI);
  try {
    const framingBytes = Buffer.byteLength('{"candidate":{"text":""},"reasoning":""}');
    for (const excess of [0, 1]) {
      const body = { model: "gpt6.1-sol", stream: true, store: false, max_output_tokens: 4_000,
        tools: ["logs_read", "code_search"].map((name) => ({ type: "function", name, parameters: { type: "object", properties: {}, additionalProperties: false } })),
        input: [{ role: "system", content: "Synthetic generation-bound contract probe." },
          ...["logs_read", "code_search"].map((name) => ({ type: "function_call", name, call_id: `call_${name}`, arguments: "{}" })),
          { role: "user", content: [{ type: "input_text", text: JSON.stringify({ draft: { text: "x".repeat(8_000 - framingBytes + excess) } }) }] }],
      };
      const result = await fetch(`${simulation.baseUrl}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error" });
      assert.equal(result.status, excess === 0 ? 200 : 400);
      const output = await result.text();
      assert.equal(output.includes("response.output_text.delta"), excess === 0);
      if (excess) assert.equal(output.includes("x".repeat(100)), false);
    }
    await simulation.waitForRequests(2);
    assert.deepEqual(simulation.requests().map((request) => request.statusCode), [200, 400]);
  } finally { await simulation.close(); }
});
