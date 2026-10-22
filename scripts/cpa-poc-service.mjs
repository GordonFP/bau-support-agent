import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sha256 = "ba0cd18bf7c4c12321c00888984823ab2048e90082ab776f290676184f36acdc";
export async function startCpaPocService() {
  const binary = resolve(process.env.BAU_CPA_BINARY ?? join(homedir(), "Library/Application Support/com.cpa.gui/cpa-core/cli-proxy-api"));
  const auth = resolve(process.env.BAU_CPA_AUTH_DIRECTORY ?? join(homedir(), "Library/Application Support/com.cpa.gui/oauth"));
  if (createHash("sha256").update(await readFile(binary)).digest("hex") !== sha256) throw new Error("cpa_artifact_unverified");
  // Inspect names/count only. CPA itself owns OAuth loading and refresh. No token
  // is parsed, copied, printed or placed in this application's environment.
  const files = (await readdir(auth)).filter((name) => name.endsWith(".json"));
  if (files.length !== 1 || !files[0].startsWith("codex-")) throw new Error("cpa_account_scope_unverified");
  const directory = await mkdtemp(join(tmpdir(), "bau-cpa-runtime-"));
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const apiKey = randomUUID();
  const managementKey = randomUUID();
  const configuration = { "config-version": 8, server: { host: "127.0.0.1", port, discovery: { enabled: false } },
    management: { "allow-remote": false, "secret-key": managementKey, "disable-control-panel": true, "disable-auto-update-panel": true },
    access: { "api-keys": [apiKey] }, oauth: { "auth-dir": auth },
    routing: { retry: { "request-retry": 0, "max-retry-credentials": 1, "max-retry-interval": 0 }, cooldown: { "save-cooldown-status": false } },
    requests: { "proxy-url": "", streaming: { "bootstrap-retries": 0, "stream-bootstrap-buffering": false } }, plugins: { enabled: false },
    observability: { logs: { debug: false, "logging-to-file": false, "request-log": false, "error-logs-max-files": 1 }, usage: { "usage-statistics-enabled": false } } };
  const path = join(directory, "cpa.json");
  await writeFile(path, JSON.stringify(configuration), { mode: 0o600 });
  const child = spawn(binary, ["-config", path, "-local-model"], { cwd: directory, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: "ignore" });
  const exited = once(child, "close");
  let spawnFailed = false;
  child.once("error", () => { spawnFailed = true; });
  void exited.catch(() => {});
  const listening = () => new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); done(true); }); socket.once("error", () => done(false));
  });
  let closing;
  const close = () => closing ??= (async () => {
    if (child.exitCode === null && child.signalCode === null && !spawnFailed) {
      child.kill("SIGINT");
      let timer; await Promise.race([exited, new Promise((done) => { timer = setTimeout(done, 3_000); })]); clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
    // Includes any error-request logs CPA may have emitted despite request-log:false.
    await rm(directory, { recursive: true, force: true });
  })();
  try {
    const end = performance.now() + 10_000;
    while (!await listening()) {
      if (spawnFailed || child.exitCode !== null || performance.now() >= end) throw new Error("cpa_start_failed");
      await new Promise((done) => setTimeout(done, 100));
    }
    // The management listing exposes retry metadata, not OAuth token material.
    // Per-credential retry overrides take precedence over the global zero.
    const response = await fetch(`http://127.0.0.1:${port}/v8/management/credentials`, {
      headers: { authorization: `Bearer ${managementKey}` }, redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok || !response.body) throw new Error("cpa_account_scope_unverified");
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 262_144) throw new Error("cpa_account_scope_unverified"); chunks.push(chunk); }
    const inventory = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const entries = inventory.files;
    if (!Array.isArray(entries) || entries.length !== 1 || entries[0].provider !== "codex" || entries[0].websockets === true ||
      entries[0].request_retry !== undefined && entries[0].request_retry !== 0) throw new Error("cpa_account_scope_unverified");
    return { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey, sha256, close };
  } catch (error) { await close(); throw error; }
}
