import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { schedule } from "../../troubleshooting/application/deadline.js";
import type { Ports } from "../../troubleshooting/application/ports.js";
import type { Socket, AddressInfo } from "node:net";
import type { HttpRouteHandler, IHttpServerAdapter } from "@microsoft/teams.apps";
import { MAX_ACTIVE_CASES, MAX_INBOUND_BYTES } from "../../troubleshooting/application/limits.js";

export class TeamsHttp implements IHttpServerAdapter {
  private route?: HttpRouteHandler;
  private readonly readTimers = new WeakMap<Socket, () => void>();
  private readonly work = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private closed = false;
  private closing?: Promise<void>;
  private readonly server = createServer({ maxHeaderSize: 8_192, requestTimeout: 5_000, headersTimeout: 5_000 }, (request, response) => {
    if (this.closed || this.work.size >= MAX_ACTIVE_CASES) { this.respond(response, 503); return; }
    const controller = new AbortController();
    this.controllers.add(controller);
    request.once("aborted", () => controller.abort());
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    const task = this.receive(request, response, controller.signal).catch(() => this.respond(response, 400));
    this.work.add(task);
    void task.finally(() => { this.work.delete(task); this.controllers.delete(controller); });
  });
  constructor(private readonly handle: (body: unknown, headers: Record<string, string | string[]>, signal: AbortSignal, route: HttpRouteHandler) => Promise<{ status: number; body?: unknown }>, clock: Ports["clock"]) {
    this.server.maxConnections = MAX_ACTIVE_CASES;
    this.server.on("connection", (socket) => {
      const cancel = schedule(clock, clock.now() + 5_000, () => socket.destroy());
      this.readTimers.set(socket, cancel); socket.once("close", cancel);
    });
  }
  registerRoute(method: "POST", path: string, handler: HttpRouteHandler): void {
    if (method !== "POST" || path !== "/api/messages" || this.route) throw new Error("contract_unverified");
    this.route = handler;
  }
  get url(): string { const address = this.server.address() as AddressInfo | null; if (!address) throw new Error("unavailable"); return `http://127.0.0.1:${address.port}/api/messages`; }
  async start(): Promise<void> {
    if (this.closed || !this.route) throw new Error("unavailable");
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen({ port: 0, host: "127.0.0.1", backlog: MAX_ACTIVE_CASES }, () => { this.server.off("error", reject); resolve(); }); });
  }
  stop(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true;
      for (const controller of this.controllers) controller.abort();
      this.server.closeAllConnections();
      if (this.server.listening) await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
      await Promise.allSettled([...this.work]);
    })();
  }
  private respond(response: ServerResponse, status: number, body: unknown = { status: "denied" }): void {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, { "content-type": "application/json", connection: "close" }); response.end(JSON.stringify(body));
  }
  private async receive(request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<void> {
    const reject = (status: number) => { this.respond(response, status); response.once("finish", () => request.destroy()); };
    if (request.method !== "POST" || request.url !== "/api/messages") { reject(404); return; }
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "") ||
      request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") { reject(415); return; }
    const declared = request.headers["content-length"];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_INBOUND_BYTES)) { reject(413); return; }
    request.setTimeout(5_000, () => request.destroy());
    const chunks: Buffer[] = []; let count = 0;
    for await (const chunk of request) { count += chunk.length; if (count > MAX_INBOUND_BYTES) { reject(413); return; } chunks.push(Buffer.from(chunk)); }
    this.readTimers.get(request.socket)?.();
    if (signal.aborted || this.closed) return;
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers[key] = value;
    const result = await this.handle(body, headers, signal, this.route!);
    this.respond(response, result.status, result.body ?? { status: "denied" });
  }
}
