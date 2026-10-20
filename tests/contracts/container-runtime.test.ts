import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { DiagnosticReport } from "../../src/troubleshooting/domain/simulator.js";
import type { BudgetStatus } from "../../src/troubleshooting/application/model-budget.js";

const execute = promisify(execFile);
const docker = "/usr/local/bin/docker";
const image = process.env.BAU_CONTAINER_IMAGE;
const limits = ["--init", "--network", "none", "--read-only", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--cpus", "1", "--memory", "512m", "--pids-limit", "64", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m"];
const containers = new Set<string>(), volumes = new Set<string>();
const run = async (args: string[], timeout = 15000) => (await execute(docker, args, { timeout, maxBuffer: 1048576 })).stdout;
const owned = () => `bau-image28-${randomUUID()}`;
const mount = (volume: string, readonly = false) => ["--mount", `type=volume,src=${volume},dst=/var/lib/bau/records${readonly ? ",readonly" : ""}`];
const jsonLines = (value: string) => value.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
async function refuses(args: string[]) {
  await assert.rejects(run(args), (error: unknown) => {
    const refusal = error as {code: number; stdout: string; stderr: string};
    assert.equal(refusal.code, 1); assert.equal(refusal.stderr.trim(), "runtime_unavailable"); assert.doesNotMatch(refusal.stdout, /ready/); return true;
  });
}
function identity() { assert.match(image ?? "", /^sha256:[a-f0-9]{64}$/, "Pass the exact built Docker config ID, never a floating test tag."); return image!; }
async function volume() {
  const name = owned(); volumes.add(name);
  await run(["volume", "create", name]);
  // Docker initializes this new owned volume from the private image mount point.
  // Verify actual ownership instead of repairing an unknown store as root.
  await run(["run", "--rm", "--pull=never", ...limits, ...mount(name), "--entrypoint", "node", identity(), "-e",
    "const fs=require('node:fs');const s=fs.statSync('/var/lib/bau/records');if(s.uid!==process.getuid()||(s.mode&0o777)!==0o700)process.exit(1)"]);
  return name;
}
async function start(volume: string, mode?: string) {
  const name = owned(); containers.add(name);
  const driver = mode ? ["--mount", `type=bind,src=${resolve("dist/tests/fixtures/container-driver.js")},dst=/checks/driver.mjs,readonly`,
    "--mount", `type=bind,src=${resolve("dist/tests/fixtures/clock.js")},dst=/checks/clock.js,readonly`, "--entrypoint", "node"] : [];
  await run(["run", "--detach", "--pull=never", "--name", name, ...limits, ...mount(volume), ...driver, identity(), ...(mode ? ["/checks/driver.mjs", mode] : [])]);
  return name;
}
async function waiting(name: string, event: string) {
  const deadline = performance.now() + 7000;
  for (;;) {
    const output = await run(["logs", name]);
    const found = jsonLines(output).find((entry) => entry.event === event);
    if (found) return found;
    if (performance.now() >= deadline) assert.fail(`No ${event}: ${output.slice(0, 1000)}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
async function driver(volume: string, mode: string) {
  const name = await start(volume, mode);
  assert.equal((await run(["wait", name], 20000)).trim(), "0");
  const result = await run(["logs", name]);
  assert.doesNotMatch(result, /SYNTHETIC-SECRET|\/Users\/|127\.0\.0\.1|\/repos\/|\/state\//);
  return jsonLines(result).at(-1)! as unknown as { event: string; status: string; caseRef: string; view: {state: string; stopReason?: string}; report: DiagnosticReport; budget: BudgetStatus; businessActions: string[] };
}
async function cleanup() {
  for (const name of containers) await run(["rm", "--force", name]).catch(() => {});
  for (const name of volumes) await run(["volume", "rm", name]);
  containers.clear(); volumes.clear();
}

test("the actual image boots a locked non-root Mock only, and missing/readonly stores never become ready", { timeout: 40000 }, async () => {
  try {
    const data = await volume(); const name = await start(data);
    const ready = await waiting(name, "ready"); assert.equal(ready.profile, "mock");
    const inspected = JSON.parse(await run(["inspect", name]))[0] as { Config: {User: string}; HostConfig: {NetworkMode: string; ReadonlyRootfs: boolean; Memory: number; PidsLimit: number; NanoCpus: number; CapDrop: string[]}; Mounts: {Destination: string; RW: boolean}[] };
    assert.equal(inspected.Config.User, "1000:1000"); assert.equal(inspected.HostConfig.NetworkMode, "none");
    assert.equal(inspected.HostConfig.ReadonlyRootfs, true); assert.equal(inspected.HostConfig.Memory, 536870912); assert.equal(inspected.HostConfig.PidsLimit, 64);
    assert.equal(inspected.HostConfig.NanoCpus, 1000000000); assert.deepEqual(inspected.HostConfig.CapDrop, ["ALL"]);
    assert.equal(inspected.Mounts.some((item) => /docker\.sock|\/repos|\/state/.test(item.Destination)), false);
    await refuses(["run", "--rm", "--pull=never", ...limits, ...mount(data), identity()]); // Exclusive writer, no second healthy process.
    await refuses(["run", "--rm", "--pull=never", ...limits, identity()]); // Missing persistent volume.
    await run(["stop", "--time", "7", name], 10000);
    assert.ok(jsonLines(await run(["logs", name])).some((entry) => entry.event === "shutdown" && entry.state === "closed"));
    await refuses(["run", "--rm", "--pull=never", ...limits, ...mount(data, true), identity()]);
    await refuses(["run", "--rm", "--pull=never", ...limits, "--user", "1001:1001", ...mount(data), identity()]);
    await run(["run", "--rm", "--pull=never", ...limits, ...mount(data), "--entrypoint", "node", identity(), "-e", "require('node:fs').chmodSync('/var/lib/bau/records',0o755)"]);
    await refuses(["run", "--rm", "--pull=never", ...limits, ...mount(data), identity()]);
    await run(["run", "--rm", "--pull=never", ...limits, ...mount(data), "--entrypoint", "node", identity(), "-e", "require('node:fs').chmodSync('/var/lib/bau/records',0o700)"]);
    const absent = await run(["run", "--rm", "--pull=never", ...limits, "--entrypoint", "node", identity(), "-e",
      "const fs=require('node:fs');for(const p of ['/app/dist/tests','/app/dist/management','/app/dist/src/evaluation','/usr/local/bin/docker','/var/run/docker.sock','/artifact/codebase-memory-mcp'])if(fs.existsSync(p))process.exit(1);console.log('scope-ok')"]);
    assert.equal(absent.trim(), "scope-ok");
  } finally { await cleanup(); }
});

test("the same image and persistent volume complete both scenarios and retain original dedupe and budget settlement", { timeout: 40000 }, async () => {
  try {
    const data = await volume();
    const simulator = await driver(data, "simulator"); assert.equal(simulator.status, "accepted"); assert.ok(simulator.report.scene === "simulator");
    assert.deepEqual(simulator.report.simulator.dataReadiness, { satisfied: 9, missing: 1, unknown: 0 });
    const psp = await driver(data, "psp"); assert.equal(psp.status, "accepted"); assert.ok(psp.report.scene === "psp");
    assert.equal(psp.report.psp.support.status, "unsupported"); assert.equal(psp.report.psp.second.status, "not_applicable"); assert.equal(psp.report.psp.amount, null);
    const duplicate = await driver(data, "duplicate-simulator"); assert.equal(duplicate.status, "duplicate"); assert.equal(duplicate.caseRef, simulator.caseRef); assert.deepEqual(duplicate.businessActions, []);
    const reserved = await driver(data, "reserve"); assert.equal(reserved.budget.reservedMicrousd, 700000);
    const persisted = await driver(data, "ledger"); assert.deepEqual(persisted.budget, reserved.budget);
    const settled = await driver(data, "settle"); assert.equal(settled.budget.reservedMicrousd, 4000); assert.equal(settled.budget.attempts, 1);
    assert.equal(settled.budget.pocMicrousd, 6000); // Two scenario model calls + one idempotently settled call.
  } finally { await cleanup(); }
});

test("actual container interruption, graceful/unknown shutdown and in-image deadline enforcement never resume a model or send", { timeout: 60000 }, async () => {
  try {
    const data = await volume(); const interrupted = await start(data, "interrupt");
    const held = await waiting(interrupted, "held"); assert.ok(held.caseRef);
    await run(["kill", "--signal", "KILL", interrupted]); await run(["wait", interrupted]);
    const restored = await driver(data, "duplicate-interrupt"); assert.equal(restored.status, "duplicate");
    assert.equal(restored.view.state, "stopped"); assert.equal(restored.view.stopReason, "interrupted"); assert.deepEqual(restored.businessActions, []);
    assert.equal(restored.budget.reservedMicrousd, 180000); assert.equal(restored.budget.unsettledCalls, 1);
    for (const mode of ["graceful", "unknown"]) {
      const ownData = await volume(), name = await start(ownData, mode); await waiting(name, "held");
      const started = performance.now(); await run(["kill", "--signal", "TERM", name]);
      assert.equal((await run(["wait", name], 10000)).trim(), mode === "graceful" ? "0" : "1");
      const closed = jsonLines(await run(["logs", name])).find((entry) => entry.event === "shutdown");
      assert.equal(closed?.state, mode === "graceful" ? "closed" : "unknown");
      assert.ok(performance.now() - started < 8000);
      if (mode === "unknown") assert.ok(performance.now() - started >= 4900);
    }
    const timeout = await driver(await volume(), "timeout"); assert.equal(timeout.view.stopReason, "timeout");
    assert.equal(timeout.budget.reservedMicrousd, 180000); assert.equal(timeout.businessActions.includes("delivery.send"), false);
  } finally { await cleanup(); }
});

test("required in-container storage/audit faults stop business calls and record files contain only sanitized data", { timeout: 30000 }, async () => {
  try {
    const data = await volume(); const fault = await driver(data, "audit-fault");
    assert.equal(fault.view.state, "stopped"); assert.equal(fault.view.stopReason, "audit_unavailable");
    assert.equal(fault.businessActions.some((action) => ["logs.read", "model.generate", "delivery.send"].includes(action)), false);
    const startFault = await start(await volume(), "startup-fault"); assert.equal((await run(["wait", startFault])).trim(), "1");
    await run(["run", "--rm", "--pull=never", ...limits, ...mount(data, true), "--entrypoint", "node", identity(), "-e",
      "const fs=require('node:fs');for(const n of fs.readdirSync('/var/lib/bau/records')){const p='/var/lib/bau/records/'+n;if(fs.statSync(p).isFile()&&/SYNTHETIC-SECRET/.test(fs.readFileSync(p).toString()))process.exit(1)}"]);
  } finally { await cleanup(); }
});
