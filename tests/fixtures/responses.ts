import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";

export function textEvents(text: string, usage?: object) {
  const item = { type: "message", id: "msg_synthetic", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] };
  return [
    { type: "response.created", response: { id: "resp_synthetic" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_synthetic", status: "completed", model: "gpt6.1-sol", output: [item], ...(usage ? { usage } : {}) } },
  ];
}

export function sendText(response: ServerResponse, text: string, usage?: object): void {
  if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of textEvents(text, usage)) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

export function sendTool(response: ServerResponse, options: { done: boolean; terminal: boolean; name?: string; arguments?: string;
  terminalEvent?: { type: string; status?: string } }): void {
  const suffix = options.name ?? "synthetic";
  const item = { type: "function_call", id: `fc_${suffix}`, call_id: `call_${suffix}`, name: options.name ?? "logs_read", arguments: options.arguments ?? "{}", status: "completed" };
  response.writeHead(200, { "content-type": "text/event-stream" });
  const events: object[] = [
    { type: "response.created", response: { id: "resp_synthetic" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    ...[item.arguments.slice(0, 1), item.arguments.slice(1)].map((delta) => ({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta })),
    { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments },
  ];
  if (options.done) events.push({ type: "response.output_item.done", output_index: 0, item });
  if (options.terminal) events.push({ type: options.terminalEvent?.type ?? "response.completed", response: { id: "resp_synthetic",
    ...(options.terminalEvent ? options.terminalEvent.status ? { status: options.terminalEvent.status } : {} : { status: "completed" }), model: "gpt6.1-sol", output: [item] } });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
}

export async function responsesServer(handler: (body: Record<string, unknown>, response: ServerResponse) => void | Promise<void>) {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) { raw += String(chunk); if (Buffer.byteLength(raw) > 48_000) { response.writeHead(413).end(); return; } }
    requests.push(raw);
    try { await handler(JSON.parse(raw) as Record<string, unknown>, response); }
    catch { if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("fixture_unavailable");
  return { requests, baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

export function reportIn(body: Record<string, unknown>): unknown {
  const input = body.input as { role?: string; content?: { text?: string }[] }[];
  for (const message of [...input].reverse()) for (const content of message.content ?? []) {
    try { const value = JSON.parse(content.text ?? "") as { draft?: unknown }; if (value.draft) return value.draft; } catch { /* Other transcript content. */ }
  }
  throw new Error("fixture_report_missing");
}
