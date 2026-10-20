import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createResponsesGateway, responsesModelPolicy } from "../../src/adapters/model/responses.js";
import type { CallContext } from "../../src/troubleshooting/application/ports.js";
import { createMockTroubleshooting, type MockOptions } from "../../src/adapters/mock/troubleshooting.js";
import { reportIn, responsesServer, sendText, sendTool, textEvents } from "../fixtures/responses.js";
import type { ModelResponse } from "../../src/troubleshooting/application/model-contract.js";
import { ManualClock } from "../fixtures/clock.js";

const context: CallContext = { caseRef: "case-1", phaseId: 1, callId: "case-1:model:1", principalRef: "principal-1",
  tenantRef: "tenant-1", destinationRef: "private-1", policyVersion: "policy-1", approvalRef: "approval-1",
  resourceRefs: ["simulator-source"], snapshotRef: "snapshot-1", budgetRef: "case-1", deadline: 60_000, signal: new AbortController().signal };

test("ordinary in-memory Mock and unverified real routes cannot be used as native HTTP profiles", () => {
  for (const route of ["mock", "cpa", "company"] as const) assert.throws(() => createResponsesGateway({ route,
    baseUrl: "http://127.0.0.1:49999/v1", contract: responsesModelPolicy.protocol }), /contract_unverified/);
});

test("B native Responses sends the complete serialized turn only after the host approves those exact bytes", async () => {
  let wire = "";
  let approved = "";
  const server = createServer(async (request, response) => {
    for await (const chunk of request) wire += String(chunk);
    assert.equal(wire, approved);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const item = { type: "message", id: "msg_synthetic", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Synthetic answer.", annotations: [] }] };
    for (const event of [
      { type: "response.created", response: { id: "resp_synthetic" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Synthetic answer." },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_synthetic", status: "completed", model: "gpt6.1-sol", output: [item] } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const gateway = createResponsesGateway({ route: "local_protocol", baseUrl: `http://127.0.0.1:${address.port}/v1`, contract: "synthetic-responses-byte-pairs-1" });
    const result = await gateway.generate(context, { schemaVersion: 1, messages: [
      { role: "system", content: "Synthetic system instruction.", sections: { policy: "Approved synthetic policy." },
        toolsAdded: [{ name: "logs_read", description: "Read approved logs.", parameters: { type: "object", properties: {}, additionalProperties: false } }] },
      { role: "user", content: "Investigate this synthetic case." },
      { role: "assistant", content: [{ type: "toolCall", id: "call_synthetic", name: "logs_read", arguments: {} }] },
      { role: "toolResult", toolCallId: "call_synthetic", toolName: "logs_read", content: "Safe synthetic tool result.", isError: false },
    ] }, async (prepared) => { approved = prepared.canonicalInput; });
    const body = JSON.parse(wire) as { model: string; input: unknown; tools: unknown; max_output_tokens: number; stream: boolean; store: boolean };
    assert.equal(body.model, "gpt6.1-sol");
    assert.equal(body.max_output_tokens, 4_000);
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    for (const value of ["Synthetic system instruction.", "Approved synthetic policy.", "Investigate this synthetic case.", "Safe synthetic tool result.", "logs_read"])
      assert.ok(wire.includes(value), value);
    assert.deepEqual(result.message?.content, [{ type: "text", text: "Synthetic answer." }]);
    assert.equal(result.actualMicrousd, null);
    assert.equal(result.usageSource, "unknown");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("A Simulator reaches the native gateway and records the exact complete wire body before delivering its validated report", async () => {
  const server = await responsesServer((body, response) => sendText(response, JSON.stringify(reportIn(body))));
  const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol" });
  mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock }).generate;
  try {
    await mock.receive();
    await mock.closed;
    assert.equal(server.requests.length, 1);
    const stored = await mock.ports.records.export(mock.inbound, "case-1");
    assert.ok(stored?.scope === "full");
    const input = stored.records.find((record) => record.kind === "model_input")?.payload as { canonicalInput: string };
    assert.equal(input.canonicalInput, server.requests[0]);
    assert.equal(JSON.stringify(stored).includes("SYNTHETIC-SECRET"), false);
    assert.equal(server.requests[0]!.includes("SYNTHETIC-SECRET"), false);
    assert.equal(stored.view.state, "completed");
    const sent = await mock.delivery.next();
    assert.equal(sent.report.simulator.shops.length, 10);
    assert.equal(sent.destinationRef, mock.inbound.destinationRef);
    const budget = await mock.ports.budget.status("case-1");
    assert.equal(budget.attempts, 1);
    assert.equal(budget.reservedMicrousd, 180_000);
    assert.equal(budget.unsettledCalls, 0);
  } finally { await server.close(); }
});

test("the host rejects an omitted tool declaration in prepared native bytes before any HTTP dispatch", async () => {
  const server = await responsesServer((body, response) => sendText(response, JSON.stringify(reportIn(body))));
  const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol" });
  const gateway = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock });
  mock.ports.model.generate = (call, turn, beforeSend) => gateway.generate(call, turn, async (prepared) => {
    const body = JSON.parse(prepared.canonicalInput) as Record<string, unknown>;
    body.tools = [];
    const canonicalInput = JSON.stringify(body);
    await beforeSend({ ...prepared, canonicalInput, inputTokensUpperBound: Math.ceil(Buffer.byteLength(canonicalInput) / 2) });
  });
  try {
    await mock.receive(); await mock.closed;
    assert.equal(server.requests.length, 0);
    assert.equal((await mock.ports.budget.status("case-1")).attempts, 0);
    const view = await mock.application.get(mock.inbound, "case-1");
    assert.ok("state" in view && view.stopReason === "contract_unverified");
  } finally { await server.close(); }
});

test("a real pre-header socket reset has exactly one host retry with a distinct durable attempt and the original operation", async () => {
  let attempts = 0;
  const server = await responsesServer((body, response) => {
    if (++attempts === 1) { response.destroy(); return; }
    sendText(response, JSON.stringify(reportIn(body)));
  });
  const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol" });
  mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock }).generate;
  try {
    await mock.receive(); await mock.closed;
    assert.equal(server.requests.length, 2);
    const budget = await mock.ports.budget.status("case-1");
    assert.equal(budget.attempts, 2);
    assert.equal(budget.reservedMicrousd, 360_000);
    assert.equal(budget.unsettledCalls, 1);
    const records = await mock.ports.records.read(mock.inbound, "case-1");
    assert.ok(records?.scope === "full");
    assert.equal(records.view.state, "completed");
    const intents = records.audits.filter((audit) => audit.action === "model.generate" && audit.stage === "intent");
    assert.equal(intents.length, 2);
    assert.notEqual(intents[0]!.callId, intents[1]!.callId);
    assert.equal(intents[0]!.operationId, intents[1]!.operationId);
  } finally { await server.close(); }
});

test("native response bytes are bounded while receiving even when oversized SSE comments produce a small valid final report", async () => {
  const server = await responsesServer((body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`:${"synthetic-padding".repeat(70_000)}\n\n`);
    sendText(response, JSON.stringify(reportIn(body)));
  });
  const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol" });
  mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock }).generate;
  try {
    await mock.receive(); await mock.closed;
    assert.equal(server.requests.length, 1);
    assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
    const status = await mock.ports.budget.status("case-1");
    assert.equal(status.reservedMicrousd, 180_000);
    assert.equal(status.unsettledCalls, 1);
    const records = await mock.ports.records.export(mock.inbound, "case-1");
    assert.equal(JSON.stringify(records).includes("synthetic-padding"), false);
  } finally { await server.close(); }
});

test("a native terminal with unfinished tool parameters executes no tool but proves execution ended independently of unknown fees", async () => {
  const server = await responsesServer((_body, response) => sendTool(response, { done: false, terminal: true }));
  const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol", agent: async (_context, request) => {
    await request.generate({ schemaVersion: 1, messages: [{ role: "system", content: "Synthetic only." }, { role: "user", content: request.question }] });
    return request.diagnose();
  } });
  mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock }).generate;
  try {
    await mock.receive(); await mock.closed;
    assert.equal(server.requests.length, 1);
    assert.equal(mock.events.some((event) => ["logs.read", "code.search", "delivery.send"].includes(event.action)), false);
    const budget = await mock.ports.budget.status("case-1");
    assert.equal(budget.reservedMicrousd, 180_000);
    assert.equal(budget.unsettledCalls, 0);
    assert.equal(budget.charges[0]!.source, "unknown");
  } finally { await server.close(); }
});

test("the network-free Mock accepts a full neutral turn and returns a neutral assistant message through the same host gate", async () => {
  let observed: ModelResponse | undefined;
  const mock = createMockTroubleshooting({ agent: async (_context, request) => {
    observed = await request.generate({ schemaVersion: 1, messages: [{ role: "system", content: "Synthetic only." }, { role: "user", content: request.question }] }) as ModelResponse;
    return request.diagnose();
  } });
  await mock.receive(); await mock.closed;
  assert.deepEqual(observed?.message, { stopReason: "stop", content: [{ type: "text", text: "Synthetic model response." }] });
  assert.equal((await mock.ports.budget.status("case-1")).attempts, 1);
});

test("native missing, estimated and explicitly synthetic usage keep distinct durable fee sources without trusting codec zero defaults", async () => {
  for (const source of ["unknown", "estimated", "mock_usage"] as const) {
    const server = await responsesServer((body, response) => sendText(response, JSON.stringify(reportIn(body)), source === "unknown" ? undefined
      : { input_tokens: 0, output_tokens: 0, synthetic_source: source, synthetic_cost_microusd: source === "estimated" ? 0 : 1_000 }));
    const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol" });
    mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock }).generate;
    try {
      await mock.receive(); await mock.closed;
      const budget = await mock.ports.budget.status("case-1");
      assert.equal(budget.charges[0]!.source, source);
      assert.equal(budget.reservedMicrousd, source === "mock_usage" ? 1_000 : 180_000);
      assert.equal(budget.charges[0]!.actualMicrousd, source === "mock_usage" ? 1_000 : null);
      assert.equal(budget.charges[0]!.estimatedMicrousd, source === "estimated" ? 0 : null);
      assert.equal(budget.unsettledCalls, 0);
    } finally { await server.close(); }
  }
});

test("malformed UTF-8 after logical text cannot be repaired by the codec into a completed diagnostic", async () => {
  const server = await responsesServer((body, response) => {
    const events = textEvents(JSON.stringify(reportIn(body)));
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events.slice(0, -1)) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.write(Buffer.from([0x3a, 0xc3, 0x28, 0x0a, 0x0a]));
    response.end(`data: ${JSON.stringify(events.at(-1))}\n\n`);
  });
  const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol" });
  mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock }).generate;
  try {
    await mock.receive(); await mock.closed;
    assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
    assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 180_000);
    assert.equal(server.requests.length, 1);
  } finally { await server.close(); }
});

test("an SDK DONE sentinel cannot hide malformed bytes arriving before the HTTP response actually ends", async () => {
  for (const malformed of [false, true]) {
  const server = await responsesServer(async (body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of textEvents(JSON.stringify(reportIn(body)))) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.write("data: [DONE]\n\n");
    await new Promise((resolve) => setTimeout(resolve, 10));
    response.end(malformed ? Buffer.from([0x3a, 0xc3, 0x28, 0x0a, 0x0a]) : ":safe tail\n\n");
  });
  const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol" });
  mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock }).generate;
  try {
    await mock.receive(); await mock.closed;
    assert.equal(mock.events.some((event) => event.action === "delivery.send"), !malformed);
    assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 180_000);
  } finally { await server.close(); }
  }
});

test("ambient SDK debug logging cannot enable an uncontrolled request or error telemetry path", async () => {
  const server = await responsesServer((body, response) => sendText(response, JSON.stringify(reportIn(body))));
  const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol" });
  mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock }).generate;
  const previous = process.env.OPENAI_LOG;
  try {
    process.env.OPENAI_LOG = "debug";
    await mock.receive(); await mock.closed;
    assert.equal(server.requests.length, 0);
    assert.equal((await mock.ports.budget.status("case-1")).attempts, 0);
  } finally { if (previous === undefined) delete process.env.OPENAI_LOG; else process.env.OPENAI_LOG = previous; await server.close(); }
});

test("pre-header cancellation or timeout aborts only its physical request and retains unknown charges while another case completes", { timeout: 3_000 }, async () => {
  for (const reason of ["cancelled", "timeout"] as const) {
    const started = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    const clock = new ManualClock();
    const server = await responsesServer(async (body, response) => {
      const draft = reportIn(body) as { caseRef: string };
      if (draft.caseRef === "case-1") { response.once("close", () => disconnected.resolve()); started.resolve(); await late.promise; }
      sendText(response, JSON.stringify(draft));
    });
    const mock = createMockTroubleshooting({ clock, modelPolicy: responsesModelPolicy, modelProfile: "local_protocol" });
    mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock }).generate;
    try {
      await mock.receive(); await started.promise;
      await mock.receive({ eventRef: "other-case" }); await mock.phaseClosed(1, "case-2");
      if (reason === "cancelled") await mock.application.cancel(mock.inbound, "case-1");
      else clock.advance(60_000);
      await mock.phaseClosed(1, "case-1"); await disconnected.promise;
      late.resolve(); await new Promise((done) => setImmediate(done));
      const first = await mock.application.get(mock.inbound, "case-1");
      const second = await mock.application.get(mock.inbound, "case-2");
      assert.ok("state" in first && first.state === "stopped" && first.stopReason === reason);
      assert.ok("state" in second && second.state === "completed");
      assert.equal(server.requests.length, 2);
      assert.equal((await mock.ports.budget.status("case-1")).reservedMicrousd, 180_000);
      assert.equal((await mock.ports.budget.status("case-1")).unsettledCalls, 1);
      const delivered = mock.events.filter((event) => event.action === "delivery.send");
      assert.equal(delivered.length, 1);
      assert.equal((delivered[0]!.input as { report: { caseRef: string } }).report.caseRef, "case-2");
    } finally { late.resolve(); await server.close(); }
  }
});

test("cancellation while native serialization is pending cannot update the stopped case or admit a send", async () => {
  const reached = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const server = await responsesServer((body, response) => sendText(response, JSON.stringify(reportIn(body))));
  const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol" });
  const gateway = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock });
  mock.ports.model.generate = async (call, turn, beforeSend) => {
    try { return await gateway.generate(call, turn, async (prepared) => { reached.resolve(); await resume.promise; await beforeSend(prepared); }); }
    finally { finished.resolve(); }
  };
  try {
    await mock.receive(); await reached.promise;
    await mock.application.cancel(mock.inbound, "case-1");
    const stopped = await mock.application.get(mock.inbound, "case-1");
    resume.resolve(); await finished.promise;
    assert.deepEqual(await mock.application.get(mock.inbound, "case-1"), stopped);
    assert.equal(server.requests.length, 0);
    assert.equal((await mock.ports.budget.status("case-1")).attempts, 0);
    const saved = await mock.ports.records.export(mock.inbound, "case-1");
    assert.equal(saved?.records.some((record) => record.kind === "model_input"), false);
  } finally { resume.resolve(); await server.close(); }
});

test("native authorization, persistent intent, sensitive input and complete-wire limit failures make zero physical requests", async () => {
  for (const fault of ["intent", "revoked", "sensitive", "oversized", "missing-output-limit"] as const) {
    const server = await responsesServer((body, response) => sendText(response, JSON.stringify(reportIn(body))));
    const denyActions: string[] = [];
    const mock = createMockTroubleshooting({ denyActions, modelPolicy: responsesModelPolicy, modelProfile: "local_protocol",
      ...(fault === "intent" ? { auditFails: "model.generate:intent" } : {}),
      ...(fault === "revoked" ? { controlPorts: (ports) => { const records = ports.records; return { records: { ...records, append: async (call, record) => {
        await records.append(call, record); if (record.kind === "model_input") denyActions.push("model.generate");
      } } }; } } satisfies Pick<MockOptions, "controlPorts"> : {}),
      ...(["sensitive", "oversized"].includes(fault) ? { agent: async (_call, request) => request.generate({ schemaVersion: 1, messages: [
        { role: "system", content: "Synthetic only." }, { role: "user", content: fault === "sensitive" ? "SYNTHETIC-SECRET-MODEL-INPUT" : "x".repeat(48_001) },
      ] }) } satisfies Pick<MockOptions, "agent"> : {}),
    });
    const gateway = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock });
    mock.ports.model.generate = fault !== "missing-output-limit" ? gateway.generate : (call, turn, beforeSend) => gateway.generate(call, turn, async (prepared) => {
      const body = JSON.parse(prepared.canonicalInput) as Record<string, unknown>; delete body.max_output_tokens;
      const canonicalInput = JSON.stringify(body);
      await beforeSend({ ...prepared, canonicalInput, inputTokensUpperBound: Math.ceil(Buffer.byteLength(canonicalInput) / 2) });
    });
    try {
      await mock.receive(); await mock.closed;
      assert.equal(server.requests.length, 0, fault);
      assert.equal((await mock.ports.budget.status("case-1")).attempts, 0, fault);
      assert.equal(mock.events.some((event) => event.action === "delivery.send"), false, fault);
      const saved = await mock.ports.records.export(mock.inbound, "case-1");
      assert.equal(JSON.stringify(saved).includes("SYNTHETIC-SECRET"), false, fault);
    } finally { await server.close(); }
  }
});

test("only completed, valid split tool parameters may reach a tool; missing terminal keeps execution and fee unknown", async () => {
  for (const mode of ["complete", "unfinished", "no-terminal", "malformed", "extra-parameter"] as const) {
    const server = await responsesServer((_body, response) => sendTool(response, { done: mode !== "unfinished", terminal: mode !== "no-terminal",
      arguments: mode === "malformed" ? "{" : mode === "extra-parameter" ? '{"index":"*"}' : "{}" }));
    const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol", agent: async (_call, request) => {
      const response = await request.generate({ schemaVersion: 1, messages: [{ role: "system", content: "Synthetic only.", toolsAdded: [{ name: "logs_read",
        description: "Approved synthetic logs.", parameters: { type: "object", properties: {}, additionalProperties: false } }] }, { role: "user", content: request.question }] }) as ModelResponse;
      for (const part of response.message.content) if (part.type === "toolCall") await request.invoke("logs.read", null);
      return request.diagnose();
    } });
    mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock }).generate;
    try {
      await mock.receive(); await mock.closed;
      assert.equal(server.requests.length, 1, mode);
      assert.equal(mock.events.filter((event) => event.action === "logs.read").length, mode === "complete" ? 1 : 0, mode);
      assert.equal(mock.events.some((event) => event.action === "delivery.send"), mode === "complete", mode);
      const status = await mock.ports.budget.status("case-1");
      assert.equal(status.reservedMicrousd, 180_000, mode);
      assert.equal(status.unsettledCalls, mode === "no-terminal" ? 1 : 0, mode);
    } finally { await server.close(); }
  }
});

test("the native physical path shares two unsettled slots and a queued third attempt expires without HTTP or a reservation", { timeout: 3_000 }, async () => {
  const twoStarted = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const clock = new ManualClock();
  let calls = 0;
  const server = await responsesServer(async (body, response) => { if (++calls === 2) twoStarted.resolve(); await finish.promise; sendText(response, JSON.stringify(reportIn(body))); });
  const mock = createMockTroubleshooting({ clock, modelPolicy: responsesModelPolicy, modelProfile: "local_protocol" });
  mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock }).generate;
  try {
    await mock.receive(); await mock.receive({ eventRef: "second" }); await twoStarted.promise;
    await mock.receive({ eventRef: "queued" }); await new Promise((done) => setImmediate(done));
    assert.equal(server.requests.length, 2);
    clock.advance(60_000); await mock.phaseClosed(1, "case-3");
    const third = await mock.application.get(mock.inbound, "case-3");
    assert.ok("state" in third && third.stopReason === "timeout");
    assert.equal((await mock.ports.budget.status("case-3")).attempts, 0);
    assert.equal((await mock.ports.budget.status("case-3")).reservedMicrousd, 0);
    assert.equal((await mock.ports.budget.status("case-3")).unsettledCalls, 2);
    assert.equal(server.requests.length, 2);
  } finally { finish.resolve(); await server.close(); }
});

test("a synthetic charge contradicting the proven bound remains truthful and closes subsequent native admission", async () => {
  const server = await responsesServer((body, response) => sendText(response, JSON.stringify(reportIn(body)),
    { input_tokens: 0, output_tokens: 0, synthetic_source: "mock_usage", synthetic_cost_microusd: 180_001 }));
  const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol" });
  mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock }).generate;
  try {
    await mock.receive(); await mock.closed;
    const first = await mock.ports.budget.status("case-1");
    assert.equal(first.reservedMicrousd, 180_001);
    assert.equal(first.contractViolated, true);
    await mock.receive({ eventRef: "after-contradiction" }); await mock.phaseClosed(1, "case-2");
    assert.equal(server.requests.length, 1);
    assert.equal((await mock.ports.budget.status("case-2")).attempts, 0);
    assert.equal(mock.events.some((event) => event.action === "delivery.send"), false);
  } finally { await server.close(); }
});

test("exactly 24k synthetic tokens of final native serialized input are admitted and the next token makes zero HTTP", async () => {
  const server = await responsesServer((_body, response) => sendText(response, "Safe synthetic reply."));
  const empty = { schemaVersion: 1 as const, messages: [{ role: "system" as const, content: "Synthetic only." }, { role: "user" as const, content: "" }] };
  let overhead = 0;
  const gateway = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl });
  try {
    await assert.rejects(gateway.generate(context, empty, async (prepared) => { overhead = Buffer.byteLength(prepared.canonicalInput); throw new Error("contract_unverified"); }), /contract_unverified/);
    assert.equal(server.requests.length, 0);
    for (const excess of [0, 1]) {
      const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol", agent: async (_call, request) => request.generate({
        schemaVersion: 1, messages: [empty.messages[0]!, { role: "user", content: "x".repeat(48_000 - overhead + excess * 2) }],
      }) });
      mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock }).generate;
      await mock.receive(); await mock.closed;
      assert.equal((await mock.ports.budget.status("case-1")).attempts, excess === 0 ? 1 : 0);
      if (excess === 0) { assert.equal(Buffer.byteLength(server.requests[0]!), 48_000); }
      assert.equal(server.requests.length, 1);
    }
  } finally { await server.close(); }
});

test("a seventh native request cannot bypass the cumulative six physical attempts or rolling-start ledger", async () => {
  const server = await responsesServer((body, response) => sendText(response, JSON.stringify(reportIn(body)),
    { input_tokens: 0, output_tokens: 0, synthetic_source: "mock_usage", synthetic_cost_microusd: 1_000 }));
  const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol", agent: async (_call, request) => {
    let candidate: unknown;
    for (let attempt = 0; attempt < 7; attempt++) candidate = await request.generate(request.diagnose());
    return candidate;
  } });
  mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock }).generate;
  try {
    await mock.receive(); await mock.closed;
    assert.equal(server.requests.length, 6);
    const status = await mock.ports.budget.status("case-1");
    assert.equal(status.attempts, 6);
    assert.equal(status.startsLast60s, 6);
    assert.equal(status.reservedMicrousd, 6_000);
    assert.equal(status.unsettledCalls, 0);
    const view = await mock.application.get(mock.inbound, "case-1");
    assert.ok("state" in view && view.stopReason === "budget_exhausted");
  } finally { await server.close(); }
});

test("native failed retries, upstream errors, unsafe responses and foreign reports never disclose raw data or change the fixed report audience", async () => {
  for (const mode of ["reset", "error", "secret", "foreign"] as const) {
    const server = await responsesServer((body, response) => {
      if (mode === "reset") { response.destroy(); return; }
      if (mode === "error") { response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "SYNTHETIC-SECRET-UPSTREAM /private/synthetic" } })); return; }
      if (mode === "secret") { sendText(response, "SYNTHETIC-SECRET-OUTPUT /private/synthetic"); return; }
      const report = structuredClone(reportIn(body)) as Record<string, unknown>;
      report.caseRef = "other-case"; report.destinationRef = "other-conversation";
      sendText(response, JSON.stringify(report));
    });
    const mock = createMockTroubleshooting({ modelPolicy: responsesModelPolicy, modelProfile: "local_protocol" });
    mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", contract: responsesModelPolicy.protocol, baseUrl: server.baseUrl, clock: mock.ports.clock }).generate;
    try {
      await mock.receive(); await mock.closed;
      const attempts = mode === "reset" ? 2 : 1;
      assert.equal(server.requests.length, attempts, mode);
      const status = await mock.ports.budget.status("case-1");
      assert.equal(status.attempts, attempts, mode);
      assert.equal(status.reservedMicrousd, attempts * 180_000, mode);
      assert.equal(mock.events.some((event) => event.action === "delivery.send"), false, mode);
      const records = await mock.ports.records.export(mock.inbound, "case-1");
      const exits = mock.events.filter((event) => event.action.startsWith("audit:") || event.action.startsWith("model.") || event.action.startsWith("delivery."));
      const retained = JSON.stringify({ records, exits, requests: server.requests });
      assert.equal(retained.includes("SYNTHETIC-SECRET"), false, mode);
      assert.equal(retained.includes("/private/synthetic"), false, mode);
    } finally { await server.close(); }
  }
});
