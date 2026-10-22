// Reviewed local-only Responses subset; generated from the contract then made stateful by transcript.
// No provider, credentials, upstream forwarding or real GPT tokenizer/billing is implemented.
const http = require("node:http");
const cpaPoc = process.env.BAU_MOCK_CPA_POC === "1";
const model = cpaPoc ? "gpt-6.1-sol" : "gpt6.1-sol";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (response, status) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { code: "synthetic_contract_rejected" } })); };
const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || new URL(request.url, "http://localhost").pathname !== "/v1/responses") return fail(response, 501);
    let body = request.body;
    if (body === undefined) {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { const value = Buffer.from(chunk); bytes += value.length; if (bytes > 48_000) return fail(response, 413); chunks.push(value); }
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    }
    if (typeof body === "string") body = JSON.parse(body);
    if (!body || body.model !== model || (cpaPoc ? Object.hasOwn(body, "max_output_tokens") : body.max_output_tokens !== 4_000) || body.stream !== true || body.store !== false ||
      !Array.isArray(body.input) || !Array.isArray(body.tools) || body.tools.length !== 2 ||
      body.tools.some((tool) => tool.type !== "function" || !["logs_read", "code_search"].includes(tool.name) ||
        tool.parameters?.type !== "object" || tool.parameters?.additionalProperties !== false || Object.keys(tool.parameters?.properties ?? {}).length)) return fail(response, 400);
    const previous = body.input.filter((item) => item.type === "function_call").map((item) => item.name);
    const name = !previous.includes("logs_read") ? "logs_read" : !previous.includes("code_search") ? "code_search" : null;
    let candidate;
    if (!name) for (const message of [...body.input].reverse()) for (const part of Array.isArray(message.content) ? message.content : []) {
      try { const value = JSON.parse(part.text); if (candidate === undefined && value.draft) candidate = value.draft; } catch { /* Other transcript text. */ }
    }
    if (!name && candidate === undefined) return fail(response, 400);
    if (!name && candidate?.scene === "psp") candidate = { reportRef: candidate.reportRef, draftVersion: candidate.draftVersion };
    const text = name ? "" : JSON.stringify(candidate);
    const item = name ? { type: "function_call", id: `fc_${name}`, call_id: `call_${name}`, name, arguments: "{}", status: "completed" }
      : { type: "message", id: "msg_synthetic", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    // Local synthetic definition bounds the actual assistant text/tool calls plus reasoning, including escaping.
    // Enforced BEFORE emitting any generated delta; reasoning is disabled/empty in this profile.
    const generated = JSON.stringify({ content: name ? [{ type: "toolCall", id: `call_${name}`, name, arguments: {} }] : [{ type: "text", text }], reasoning: "" });
    if (!cpaPoc && Math.ceil(Buffer.byteLength(generated) / 2) > 4_000) return fail(response, 400);
    const events = [{ type: "response.created", response: { id: "resp_synthetic" } },
      { type: "response.output_item.added", output_index: 0, item: name ? { ...item, arguments: "" } : { ...item, content: [] } }];
    if (name) events.push(...["{", "}"].map((delta) => ({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta })),
      { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: "{}" });
    else events.push({ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text });
    events.push({ type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_synthetic", status: "completed", model, output: [item],
        usage: cpaPoc ? { input_tokens: 123, output_tokens: 456, output_tokens_details: { reasoning_tokens: 0 } }
          : { input_tokens: 0, output_tokens: 0, synthetic_source: "mock_usage", synthetic_cost_microusd: 1_000 } } });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.flushHeaders?.();
    for (const event of events) { response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); await pause(5); }
    response.end();
  } catch { if (!response.headersSent) fail(response, 400); else response.end(); }
});
server.listen(process.env.PORT || 4500);
