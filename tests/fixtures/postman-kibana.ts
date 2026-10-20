import { spawn } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { once } from "node:events";
import { resolve } from "node:path";

export async function postmanKibana(cli: string) {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address !== "object") throw new Error("fixture_unavailable");
  const port = address.port;
  await new Promise<void>((done) => probe.close(() => done()));
  const child = spawn(cli, ["simulation", "run", resolve("postman/simulations/kibana.sim.yaml"), "--port", String(port), "--output", "ndjson"],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const startup = Promise.withResolvers<void>();
  const exit = once(child, "close");
  let stdout = "", stderr = "";
  const stop = (signal: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, signal); } catch { /* Already closed. */ } };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (Buffer.byteLength(stdout) > 262_144) { stop("SIGKILL"); startup.reject(new Error("fixture_log_limit")); }
    for (const line of stdout.split("\n")) try {
      const event = JSON.parse(line) as { event?: string; port?: number };
      if (event.event === "listening" && event.port === port) startup.resolve();
    } catch { /* Incomplete NDJSON line. */ }
  });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8_192) stderr += chunk.toString("utf8"); });
  child.once("error", () => startup.reject(new Error("fixture_unavailable")));
  child.once("exit", () => startup.reject(new Error("fixture_unavailable")));
  const timeout = setTimeout(() => startup.reject(new Error("fixture_start_timeout")), 10_000);
  const close = async () => {
    stop("SIGINT");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exit, new Promise<void>((done) => { timer = setTimeout(done, 5_000); })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { stop("SIGKILL"); await exit; }
    const listening = await new Promise<boolean>((done) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); done(true); });
      socket.once("error", () => done(false));
    });
    if (listening) throw new Error("fixture_listener_retained");
  };
  const requests = () => stdout.split("\n").flatMap((line) => { try { const value = JSON.parse(line) as Record<string, unknown>; return value.event === "request" ? [value] : []; } catch { return []; } });
  const waitForRequests = async (count: number) => {
    if (requests().length >= count) return;
    const ready = Promise.withResolvers<void>();
    const changed = () => { if (requests().length >= count) ready.resolve(); };
    child.stdout.on("data", changed);
    const timer = setTimeout(() => ready.reject(new Error("fixture_request_log_timeout")), 3_000);
    try { changed(); await ready.promise; } finally { clearTimeout(timer); child.stdout.off("data", changed); }
  };
  try { await startup.promise; } catch (error) { await close(); throw error; } finally { clearTimeout(timeout); }
  return { baseUrl: `http://127.0.0.1:${port}/kibana`, logs: () => ({ stdout, stderr }),
    requests, waitForRequests, close };
}
