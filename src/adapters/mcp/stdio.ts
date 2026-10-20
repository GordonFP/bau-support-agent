import { McpFailure } from "./failure.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ProgressNotificationSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { MCP_BYTES, FRAGMENT_BYTES } from "./manifest.js";
import type { SafeReason } from "../../troubleshooting/application/ports.js";

export interface StdioEndpoint {
  readonly command: string;
  readonly args: readonly string[];
  readonly artifact: { readonly path: string; readonly sha256: string };
}

// One host logical operation owns the entire connection, including all pages and notifications.
// The SDK owns JSON-RPC parsing/correlation; no SDK private process/buffer hooks are used.
export class BoundedStdio implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: NonNullable<Transport["onmessage"]>;
  protocolVersion?: string;
  failure?: SafeReason;
  private child?: ChildProcessWithoutNullStreams;
  private readonly reader = new ReadBuffer({ maxBufferSize: MCP_BYTES });
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });
  private bytes = 0;
  private stderrBytes = 0;
  private tail = 0;
  private closed = false;
  private readonly pending = new Set<string | number>();
  private exited?: Promise<void>;
  private closing?: Promise<void>;
  constructor(private readonly endpoint: StdioEndpoint) {}
  setProtocolVersion(version: string): void { this.protocolVersion = version; }
  async start(): Promise<void> {
    if (this.child || this.closed) throw new McpFailure("unavailable");
    this.child = spawn(this.endpoint.command, [...this.endpoint.args], {
      shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      env: { LANG: "C.UTF-8", TZ: "UTC" },
    });
    const child = this.child;
    this.exited = new Promise((resolve) => child.once("close", () => { this.finish(); resolve(); }));
    child.on("error", () => this.fail("unavailable"));
    child.stdin.on("error", () => this.fail("unavailable"));
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > FRAGMENT_BYTES) this.fail("unsafe_content");
      // Never retain, print or relay untrusted stderr.
    });
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    await once(child, "spawn");
  }
  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.bytes += chunk.length;
    if (this.bytes > MCP_BYTES) { this.fail("unsafe_content"); return; }
    if (!this.pending.size) { this.fail("schema_mismatch"); return; }
    for (const byte of chunk) {
      this.tail++;
      if (this.tail > MCP_BYTES) { this.fail("unsafe_content"); return; }
      if (byte === 10) this.tail = 0;
    }
    try {
      // Validate streaming UTF-8 before the SDK's non-fatal Buffer.toString parser.
      this.utf8.decode(chunk, { stream: true });
      this.reader.append(chunk);
      for (;;) {
        const message = this.reader.readMessage();
        if (!message) break;
        if ("method" in message) {
          if (message.method !== "notifications/progress" || "id" in message || !this.pending.size) throw new Error();
          const params = message.params;
          if (!params || Object.keys(params).some((key) => !["progressToken", "progress", "total", "message"].includes(key)) ||
            (typeof params.progressToken !== "number" && typeof params.progressToken !== "string") || !this.pending.has(params.progressToken)) throw new Error();
          if (!ProgressNotificationSchema.safeParse(message).success) throw new Error();
        } else {
          if (message.id === undefined || !this.pending.delete(message.id)) throw new Error();
        }
        this.onmessage?.(message);
        if (this.closed) break;
      }
    } catch { this.fail("schema_mismatch"); }
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.child) throw new Error(this.failure ?? "unavailable");
    if ("method" in message && "id" in message) {
      if (this.pending.size) throw new McpFailure("unavailable");
      this.pending.add(message.id);
    }
    const body = serializeMessage(message);
    if (Buffer.byteLength(body) > MCP_BYTES) throw new McpFailure("invalid_request");
    if (!this.child.stdin.write(body)) await once(this.child.stdin, "drain");
  }
  assertComplete(): void {
    if (this.failure) throw new McpFailure(this.failure);
    if (this.tail || this.pending.size) { this.fail("schema_mismatch"); throw new McpFailure("schema_mismatch"); }
  }
  fail(reason: SafeReason): void {
    if (this.closed) return;
    this.failure ??= reason;
    this.finish();
    void this.close();
  }
  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.reader.clear();
    this.onclose?.();
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.finish();
    this.closing = (async () => {
      const child = this.child;
      if (!child) return;
      child.stdin.destroy();
      const kill = (signal: NodeJS.Signals) => {
        try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already gone */ }
      };
      kill("SIGTERM");
      // Also kill an owned descendant group if its parent exited first.
      await new Promise<void>((resolve) => setTimeout(() => { kill("SIGKILL"); resolve(); }, 100));
      await this.exited;
    })();
    return this.closing;
  }
}
