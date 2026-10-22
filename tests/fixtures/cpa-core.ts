import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Actual pinned CPA, API-key synthetic Codex upstream, empty OAuth directory.
// Never loads the user's account and never contacts a real model.
export async function syntheticCpaCore(binary: string, upstream: string) {
  if (createHash("sha256").update(await readFile(binary)).digest("hex") !== "9f613e38302bb2b798cb798910c4862757bc7ae2f5032ec6d872f170d27c9c84") throw new Error("fixture_artifact_unverified");
  const root = await mkdtemp(join(tmpdir(), "bau-cpa-core-"));
  await mkdir(join(root, "auth"), { mode: 0o700 });
  const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const address = reserve.address(); if (!address || typeof address === "string") throw new Error("fixture_unavailable");
  await new Promise<void>((done) => reserve.close(() => done()));
  const apiKey = `synthetic-${randomUUID()}`;
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ "config-version": 8, server: { host: "127.0.0.1", port: address.port, discovery: { enabled: false } },
    multimedia: { "disable-image-generation": true },
    management: { "allow-remote": false, "disable-control-panel": true, "disable-auto-update-panel": true },
    access: { "api-keys": [apiKey] }, oauth: { "auth-dir": join(root, "auth") },
    "api-keys": { codex: [{ name: "synthetic", "base-url": upstream, "proxy-url": "direct", models: [{ name: "gpt-6.1-sol" }], keys: [{ "api-key": "synthetic-upstream", "request-retry": 0, websockets: false }] }] },
    routing: { retry: { "request-retry": 0, "max-retry-credentials": 1, "max-retry-interval": 0 } },
    requests: { "proxy-url": "", streaming: { "bootstrap-retries": 0 } }, plugins: { enabled: false },
    observability: { logs: { "logging-to-file": false, "request-log": false, "error-logs-max-files": 1 }, usage: { "usage-statistics-enabled": false } },
  }), { mode: 0o600 });
  const child = spawn(binary, ["-config", path, "-local-model"], { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: "ignore" });
  const exited = once(child, "close"); void exited.catch(() => {});
  let failed = false; child.once("error", () => { failed = true; });
  const listening = () => new Promise<boolean>((done) => { const socket = createConnection({ host: "127.0.0.1", port: address.port });
    socket.once("connect", () => { socket.destroy(); done(true); }); socket.once("error", () => done(false)); });
  const close = async () => {
    if (!failed && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGINT"); let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exited, new Promise<void>((done) => { timer = setTimeout(done, 3_000); })]); clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
    if (await listening()) throw new Error("fixture_listener_retained");
    await rm(root, { recursive: true, force: true });
  };
  try {
    const deadline = performance.now() + 10_000;
    while (!await listening()) { if (failed || child.exitCode !== null || performance.now() >= deadline) throw new Error("fixture_unavailable"); await new Promise((done) => setTimeout(done, 100)); }
    return { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey, close };
  } catch (error) { await close(); throw error; }
}
