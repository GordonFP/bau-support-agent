import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir, chmod, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { syntheticGitLab } from "../fixtures/gitlab.js";
import { researchImage, localReadService, dockerCommand } from "../../management/codebase-docker.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { SnapshotCollection } from "../../src/adapters/codebase-memory/collection.js";
import { codebaseMemoryPorts, type CodebaseMemoryOptions } from "../../src/adapters/codebase-memory/evidence.js";
import { McpBoundary } from "../../src/adapters/mcp/boundary.js";
import type { CallContext } from "../../src/troubleshooting/application/ports.js";
import { ManualClock } from "../fixtures/clock.js";
import { lateDocker } from "../fixtures/late-docker.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../management/codebase-snapshot.js", import.meta.url));
const profile = { docker: "/usr/local/bin/docker", binary: "/tmp/bau-cbm-runtime/bin/codebase-memory-mcp", image: researchImage } as const;
async function publish(root: string, gitlab: Awaited<ReturnType<typeof syntheticGitLab>>, count = 2) {
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ mode: "local_synthetic", root, ...profile, gitlab: gitlab.url, repositories: gitlab.repositories.slice(0, count) }));
  const { stdout } = await execute(process.execPath, [cli, config], { timeout: 45_000, maxBuffer: 16_384 }).catch(async () => {
    const file = (await readdir(root)).find((name) => name.startsWith("failed-"));
    assert.fail(file ? await readFile(join(root, file), "utf8") : "CLI failed before publication attempt");
  });
  return JSON.parse(stdout) as import("../../src/adapters/codebase-memory/collection.js").CollectionReceipt;
}
function setup(root: string, snapshotRef: string, resources = ["simulator-source", "estimate-source"], suppliedService?: CodebaseMemoryOptions["service"]) {
  const mock = createMockTroubleshooting({ clock: { now: () => performance.now(), utc: () => new Date().toISOString() } });
  const originalAllows = mock.ports.authorization.allows;
  mock.ports.authorization.allows = (action, context) => action.startsWith("mcp.code.")
    ? Promise.resolve(context.principalRef === "principal-1" && context.resourceRefs.every((item) => resources.includes(item))) : originalAllows(action, context);
  const boundary = new McpBoundary(mock.ports);
  const collection = new SnapshotCollection(root);
  const native = codebaseMemoryPorts(mock.ports, boundary, { approvedCaseResourceRefs: resources, collection, service: suppliedService ?? localReadService(profile, (snapshot) => collection.path(snapshot)),
    resolveTarget: () => "SYNTHETIC-SECRET-APPLICATION" });
  const context = (callId: string, overrides: Partial<CallContext> = {}): CallContext => ({ caseRef: "case-1", phaseId: 1, callId,
    principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1", policyVersion: "synthetic-policy-1",
    approvalRef: "synthetic-approval-1", resourceRefs: resources, snapshotRef, budgetRef: "case-1", deadline: mock.ports.clock.now() + 30_000,
    signal: new AbortController().signal, ...overrides });
  return { mock, native, context, collection, boundary };
}
async function removeOwnedTree(root: string): Promise<void> {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) await removeOwnedTree(join(root, entry.name));
  await rm(root, { recursive: true, force: true });
}
test("independent management CLI syncs exact synthetic GitLab branches and atomically publishes native multi-repository provenance", { timeout: 60_000 }, async () => {
  const gitlab = await syntheticGitLab();
  const root = await mkdtemp(join(tmpdir(), "bau-cbm-collection-"));
  try {
    const receipt = await publish(root, gitlab);
    assert.equal(receipt.repositories.length, 2);
    assert.deepEqual(receipt.repositories.map((item: {branch: string}) => item.branch), ["main", "master"]);
    assert.ok(receipt.repositories.every((item: {databaseSha256: string; sourceSha256: string}) => /^[a-f0-9]{64}$/.test(item.databaseSha256) && /^[a-f0-9]{64}$/.test(item.sourceSha256)));
    assert.equal(receipt.crossRepository.status, "complete");
    const proof = JSON.parse(await readFile(join(root, "collections", receipt.snapshotRef, "proof.json"), "utf8")) as {operation: string; result: {mode?: string; total_cross_edges?: number}}[];
    assert.ok(proof.some((entry) => entry.result.mode === "cross-repo-intelligence" && (entry.result.total_cross_edges ?? 0) > 0));
    assert.deepEqual(JSON.parse(await readFile(join(root, "current.json"), "utf8")), receipt);
    assert.ok(gitlab.events.some((event) => event.includes("git-upload-pack")));
  } finally { await gitlab.close(); await removeOwnedTree(root); }
});

test("management pauses new B admissions, drains a real native read and publishes the next entire collection", { timeout: 60_000 }, async () => {
  const gitlab = await syntheticGitLab();
  const root = await mkdtemp(join(tmpdir(), "bau-cbm-drain-"));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    const previous = await publish(root, gitlab);
    const collection = new SnapshotCollection(root);
    const real = localReadService(profile, (snapshot) => collection.path(snapshot));
    const { native, context } = setup(root, previous.snapshotRef, ["simulator-source", "estimate-source"], (receipt) => {
      const service = real(receipt);
      return { ...service, start: async (receipt) => { await service.start(receipt); entered.resolve(); await release.promise; } };
    });
    const pending = native.code.snippet(context("held"), { repositoryRef: "simulator-source", snapshotRef: previous.snapshotRef, symbol: "simulator.runSimulator", file: "simulator.ts" });
    await entered.promise;
    await gitlab.replaceSource(1, "export function runSimulator(): number { return 99; }\n");
    const updating = publish(root, gitlab);
    for (let attempt = 0; ; attempt++) {
      try { await access(join(root, "update.lock", "owner.json")); break; } catch { if (attempt >= 200) throw new Error("update_gate_not_created"); await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    assert.equal(JSON.parse(await readFile(join(root, "current.json"), "utf8")).snapshotRef, previous.snapshotRef);
    await assert.rejects(native.code.search(context("new-read", { caseRef: "case-2" }), { repositoryRef: "simulator-source", snapshotRef: previous.snapshotRef }), /^Error: unavailable$/);
    release.resolve();
    const old = await pending;
    assert.equal(old.evidence[0]!.code?.commit, previous.repositories[0]!.commit);
    assert.match(old.evidence[0]!.text, /calculateEstimate/);
    const next = await updating;
    assert.notEqual(next.snapshotRef, previous.snapshotRef);
    assert.notEqual(next.repositories[0]!.commit, previous.repositories[0]!.commit);
    assert.equal(next.repositories.length, 2);
    assert.equal(JSON.parse(await readFile(join(root, "current.json"), "utf8")).snapshotRef, next.snapshotRef);
    await assert.rejects(native.code.search(context("stale"), { repositoryRef: "simulator-source", snapshotRef: previous.snapshotRef }), /^Error: version_mismatch$/);
  } finally { release.resolve(); await gitlab.close(); await removeOwnedTree(root); }
});

test("a source change with an unchanged native graph is rejected before evidence can escape B", { timeout: 60_000 }, async () => {
  const gitlab = await syntheticGitLab();
  const root = await mkdtemp(join(tmpdir(), "bau-cbm-drift-"));
  try {
    const receipt = await publish(root, gitlab);
    const collection = new SnapshotCollection(root);
    const real = localReadService(profile, (snapshot) => collection.path(snapshot));
    const source = join(collection.path(receipt.snapshotRef), "sources", "simulator-source", "simulator.ts");
    const original = await readFile(source, "utf8");
    const { native, context, mock } = setup(root, receipt.snapshotRef, ["simulator-source", "estimate-source"], (selected) => {
      const service = real(selected);
      return { ...service, start: async (receipt) => {
        await service.start(receipt);
        // Test's management identity deliberately violates the frozen source after the pre-query check.
        await chmod(source, 0o644); await writeFile(source, original.replace("calculateEstimate(collectHistory())", "999"));
      } };
    });
    await assert.rejects(native.code.snippet(context("drift"), { repositoryRef: "simulator-source", snapshotRef: receipt.snapshotRef,
      symbol: "simulator.runSimulator", file: "simulator.ts" }), /^Error: version_mismatch$/);
    assert.equal(mock.events.some((event) => event.action === "audit:mcp.code.snippet:complete" && (event.input as {outcome: string}).outcome === "ok"), false);
    assert.deepEqual(await readdir(join(root, "readers")), []);
  } finally { await gitlab.close(); await removeOwnedTree(root); }
});

test("lossy native cross-service traces remain unknown and revoked target permission prevents every physical query", { timeout: 60_000 }, async () => {
  const gitlab = await syntheticGitLab();
  const root = await mkdtemp(join(tmpdir(), "bau-cbm-cross-acl-"));
  try {
    const receipt = await publish(root, gitlab);
    const collection = new SnapshotCollection(root);
    const real = localReadService(profile, (snapshot) => collection.path(snapshot));
    let starts = 0;
    const { native, context, mock } = setup(root, receipt.snapshotRef, ["simulator-source", "estimate-source"], (selected) => {
      const service = real(selected);
      return { ...service, start: async (receipt) => { starts++; await service.start(receipt); } };
    });
    const query = { repositoryRef: "simulator-source", snapshotRef: receipt.snapshotRef, symbol: "simulator.requestEstimate", file: "simulator.ts",
      direction: "outbound" as const, targetRepositoryRef: "estimate-source" };
    const read = await native.code.trace(context("cross"), query);
    assert.equal(read.completeness, "unknown");
    assert.equal(read.truncated, true);
    assert.match(read.evidence[0]!.text, /destination.*proven/);
    assert.ok(read.evidence.every((item) => item.code?.repositoryRef === "simulator-source"));
    assert.ok(read.warnings.some((warning) => warning.includes("omits destination")));
    const allows = mock.ports.authorization.allows;
    mock.ports.authorization.allows = (action, bound) => bound.resourceRefs.includes("estimate-source") ? Promise.resolve(false) : allows(action, bound);
    await assert.rejects(native.code.trace(context("revoked"), query), /^Error: denied$/);
    assert.equal(starts, 1);
    assert.deepEqual(await readdir(join(root, "readers")), []);
    assert.ok(mock.events.some((event) => event.action === "audit:authorization.denied:complete"));
  } finally { await gitlab.close(); await removeOwnedTree(root); }
});

test("actual limited native graph results preserve partial truth and a pending owned container start is reaped on cancellation", { timeout: 60_000 }, async () => {
  const gitlab = await syntheticGitLab();
  const root = await mkdtemp(join(tmpdir(), "bau-cbm-partial-cancel-"));
  const started = Promise.withResolvers<void>();
  try {
    await gitlab.replaceSource(1, Array.from({ length: 8 }, (_, index) => `export class Simulator${index} { runSimulator(): number { return ${index}; } }`).join("\n"));
    const receipt = await publish(root, gitlab);
    const regular = setup(root, receipt.snapshotRef);
    const read = await regular.native.code.search(regular.context("partial"), { repositoryRef: "simulator-source", snapshotRef: receipt.snapshotRef, term: "runSimulator", kind: "symbol" });
    assert.equal(read.evidence.length, 5);
    assert.equal(read.completeness, "partial");
    assert.equal(read.truncated, true);
    const collection = new SnapshotCollection(root);
    const real = localReadService(profile, (snapshot) => collection.path(snapshot));
    let ownedName = "";
    const { native, context } = setup(root, receipt.snapshotRef, ["simulator-source", "estimate-source"], (selected) => {
      const service = real(selected);
      ownedName = service.endpoint.args[2]!;
      return { ...service, start: (receipt) => { const pending = service.start(receipt); started.resolve(); return pending; } };
    });
    const controller = new AbortController();
    const pending = native.code.search(context("cancel", { signal: controller.signal }), { repositoryRef: "simulator-source", snapshotRef: receipt.snapshotRef });
    const rejected = assert.rejects(pending, /^Error: cancelled$/);
    await started.promise; controller.abort(); await rejected;
    assert.deepEqual(await readdir(join(root, "readers")), []);
    const absent = await execute(profile.docker, ["inspect", ownedName], { maxBuffer: 16_384, timeout: 5000 }).then(() => false,
      (error: unknown) => String((error as {stderr?: string}).stderr).trim().toLowerCase() === `error: no such object: ${ownedName}`);
    assert.equal(absent, true);
  } finally { await gitlab.close(); await removeOwnedTree(root); }
});

test("C retains an unknown Docker start after its CLI exits and an absent inspect cannot rule out an owned late create", { timeout: 60_000 }, async () => {
  const gitlab = await syntheticGitLab();
  const root = await mkdtemp(join(tmpdir(), "bau-cbm-late-create-"));
  let delayed: Awaited<ReturnType<typeof lateDocker>> | undefined;
  let ownedName: string | undefined;
  try {
    const receipt = await publish(root, gitlab, 1);
    delayed = await lateDocker(root, profile.docker);
    const clock = new ManualClock();
    const actor = { principalRef: "lifecycle-owner", tenantRef: "tenant-1", destinationRef: "lifecycle-path" };
    const mock = createMockTroubleshooting({ clock, lifecycleActors: [actor] });
    const boundary = new McpBoundary(mock.ports), collection = new SnapshotCollection(root);
    const native = codebaseMemoryPorts(mock.ports, boundary, { collection, resolveTarget: () => "synthetic-target",
      service: localReadService({ ...profile, docker: delayed.command }, (snapshot) => collection.path(snapshot)) });
    const context: CallContext = { caseRef: "case-1", phaseId: 1, callId: "unknown-start", principalRef: "principal-1", tenantRef: "tenant-1",
      destinationRef: "private-conversation-1", policyVersion: "synthetic-policy", approvalRef: "synthetic-approval", resourceRefs: ["simulator-source"],
      snapshotRef: receipt.snapshotRef, budgetRef: "case-1", deadline: 30000, signal: new AbortController().signal };
    await assert.rejects(native.code.search(context, { repositoryRef: "simulator-source", snapshotRef: receipt.snapshotRef }), /^Error: unavailable$/);
    ownedName = await delayed.name();
    await assert.rejects(dockerCommand(profile, ["inspect", ownedName])); // No container exists yet.
    await mock.ports.retention!.recordTrigger(actor, { triggerRef: "terminated", kind: "terminated", scope: "poc", decidedAt: clock.utc() });
    clock.advance(30 * 86_400_000);
    const purging = mock.ports.retention!.purgeDue(actor);
    await new Promise(setImmediate); clock.advance(5000);
    assert.equal((await purging).state, "partial");
    assert.equal((await readdir(join(root, "readers"))).length, 1);
    assert.equal(await delayed.reconcile(), true);
    assert.equal((await dockerCommand(profile, ["inspect", "--format", "{{.State.Running}}", ownedName])).toString().trim(), "true");
    await dockerCommand(profile, ["rm", "--force", ownedName]);
    // A separate administrator reconciled the resource; this retired controller
    // still cannot turn its cached unknown result into an automatic success.
    assert.equal((await mock.ports.retention!.purgeDue(actor)).state, "partial");
    assert.equal((await readdir(join(root, "readers"))).length, 1);
  } finally {
    if (delayed) {
      await delayed.reconcile();
      ownedName ??= await delayed.name();
      await dockerCommand(profile, ["rm", "--force", ownedName]).catch(() => {});
    }
    await gitlab.close(); await removeOwnedTree(root);
  }
});

test("a separately indexed narrow scope is physically read-only and a different cache cannot isolate the same native account daemon", { timeout: 60_000 }, async () => {
  const gitlab = await syntheticGitLab();
  const root = await mkdtemp(join(tmpdir(), "bau-cbm-physical-scope-"));
  let warm: Client | undefined;
  let conflicting: Client | undefined;
  try {
    const receipt = await publish(root, gitlab, 1);
    const collection = new SnapshotCollection(root);
    const real = localReadService(profile, (snapshot) => collection.path(snapshot));
    let checked = false;
    const { native, context } = setup(root, receipt.snapshotRef, ["simulator-source"], (selected) => {
      const service = real(selected);
      const name = service.endpoint.args[2]!;
      return { endpoint: { ...service.endpoint, close: async () => { await warm?.close(); await conflicting?.close(); await service.endpoint.close(); } }, start: async (receipt) => {
        await service.start(receipt);
        const inspect = JSON.parse((await dockerCommand(profile, ["inspect", name], 65_536)).toString())[0] as {
          Config: { User: string }; HostConfig: { ReadonlyRootfs: boolean; NetworkMode: string; Init: boolean; Memory: number; PidsLimit: number };
          Mounts: {Destination: string; RW: boolean}[];
        };
        assert.equal(inspect.Config.User, "1000:1000"); assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
        assert.equal(inspect.HostConfig.NetworkMode, "none"); assert.equal(inspect.HostConfig.Init, true);
        assert.equal(inspect.HostConfig.Memory, 1_610_612_736); assert.equal(inspect.HostConfig.PidsLimit, 128);
        assert.ok(inspect.Mounts.filter((mount) => mount.Destination.startsWith("/repos/") || mount.Destination.endsWith("/simulator.db")).every((mount) => !mount.RW));
        assert.equal(inspect.Mounts.some((mount) => mount.Destination.includes("estimate")), false);
        const observed = JSON.parse((await dockerCommand(profile, ["exec", name, "node", "-e", `const fs=require('node:fs');const r={};
          for(const p of ['/repos/simulator-source/simulator.ts','/state/cache/simulator.db']){try{fs.appendFileSync(p,'x');r[p]='written';}catch(e){r[p]=e.code;}}
          for(const p of ['/repos/estimate-source/estimate.ts','/state/cache/estimate.db']){try{fs.readFileSync(p);r[p]='read';}catch(e){r[p]=e.code;}}
          console.log(JSON.stringify(r));`])).toString()) as Record<string, string>;
        assert.ok(["EACCES", "EROFS"].includes(observed["/repos/simulator-source/simulator.ts"]!));
        assert.ok(["EACCES", "EROFS"].includes(observed["/state/cache/simulator.db"]!));
        assert.equal(observed["/repos/estimate-source/estimate.ts"], "ENOENT"); assert.equal(observed["/state/cache/estimate.db"], "ENOENT");
        warm = new Client({ name: "synthetic-daemon-isolation-proof", version: "1" }, { capabilities: {} }); warm.onerror = () => {};
        await warm.connect(new StdioClientTransport({ command: profile.docker, args: [...service.endpoint.args], stderr: "pipe", maxBufferSize: 1_048_576 }), { timeout: 5000 });
        conflicting = new Client({ name: "synthetic-different-cache-proof", version: "1" }, { capabilities: {} }); conflicting.onerror = () => {};
        const other = new StdioClientTransport({ command: profile.docker, args: ["exec", "--interactive", "--env", "CBM_CACHE_DIR=/tmp/other-cache", name,
          "/artifact/codebase-memory-mcp", "--tool-profile=analysis"], stderr: "pipe", maxBufferSize: 1_048_576 });
        let diagnostic = "";
        other.stderr?.on("data", (chunk: Buffer) => { if (Buffer.byteLength(diagnostic) + chunk.length > 16_384) void other.close(); else diagnostic += chunk.toString(); });
        await assert.rejects(conflicting.connect(other, { timeout: 5000 }));
        assert.match(diagnostic, /different cache directory/);
        checked = true;
      } };
    });
    const read = await native.code.snippet(context("physical"), { repositoryRef: "simulator-source", snapshotRef: receipt.snapshotRef, symbol: "simulator.runSimulator", file: "simulator.ts" });
    assert.equal(checked, true); assert.equal(read.evidence.length, 1);
    assert.equal(read.evidence[0]!.code?.commit, receipt.repositories[0]!.commit);
  } finally { await warm?.close(); await conflicting?.close(); await gitlab.close(); await removeOwnedTree(root); }
});

test("B translates all four actual native read capabilities with exact source, symbol and version bindings", { timeout: 60_000 }, async () => {
  const gitlab = await syntheticGitLab();
  const root = await mkdtemp(join(tmpdir(), "bau-cbm-reads-"));
  try {
    const receipt = await publish(root, gitlab);
    const { native, context, mock } = setup(root, receipt.snapshotRef);
    const base = { repositoryRef: "simulator-source", snapshotRef: receipt.snapshotRef };
    const source = await native.code.search(context("source"), { ...base, term: "calculateEstimate", kind: "source" });
    assert.equal(source.evidence.length, 2);
    assert.match(source.evidence[0]!.text, /function calculateEstimate/);
    const graph = await native.code.search(context("graph"), { ...base, term: "runSimulator", kind: "symbol" });
    assert.equal(graph.evidence.length, 1);
    assert.match(graph.evidence[0]!.text, /simulator\.simulator\.runSimulator/);
    const snippet = await native.code.snippet(context("snippet"), { ...base, symbol: "simulator.runSimulator", file: "simulator.ts" });
    assert.equal(snippet.evidence.length, 1);
    assert.match(snippet.evidence[0]!.text, /calculateEstimate\(collectHistory\(\)\)/);
    const trace = await native.code.trace(context("trace"), { ...base, symbol: "simulator.runSimulator", file: "simulator.ts", direction: "outbound" });
    assert.equal(trace.evidence.length, 2);
    assert.ok(trace.evidence.every((item) => item.text.includes("does not prove execution")));
    const results = [source, graph, snippet, trace];
    assert.ok(results.every((read) => read.evidence.every((item) => item.targetRef === "[case-1:application]" && item.code?.snapshotRef === receipt.snapshotRef &&
      item.code.commit === receipt.repositories[0]!.commit && item.code.receiptRef === `sha256:${receipt.receiptSha256}`)));
    assert.doesNotMatch(JSON.stringify({ results, events: mock.events }), /SYNTHETIC-SECRET|\/repos\/|\/state\/|\/Users\//);
    assert.equal(mock.events.filter((event) => event.action.startsWith("audit:mcp.code.") && event.action.endsWith(":complete")).length, 4);
    assert.deepEqual(await readdir(join(root, "readers")), []);
  } finally { await gitlab.close(); await removeOwnedTree(root); }
});

test("a partial third native index and failed GitLab synchronization retain the entire last successful collection", { timeout: 60_000 }, async () => {
  const gitlab = await syntheticGitLab();
  const root = await mkdtemp(join(tmpdir(), "bau-cbm-update-"));
  try {
    const previous = await publish(root, gitlab, 3);
    const frozen = await readFile(join(root, "current.json"), "utf8");
    await gitlab.replaceSource(3, "export function verifyPsp( {\n");
    await assert.rejects(publish(root, gitlab, 3));
    assert.equal(await readFile(join(root, "current.json"), "utf8"), frozen);
    assert.deepEqual(await readdir(join(root, "collections")), [previous.snapshotRef]);
    const failed = (await readdir(root)).filter((file) => file.startsWith("failed-"));
    assert.ok(failed.length > 0);
    assert.equal(JSON.parse(await readFile(join(root, failed[0]!), "utf8")).phase, "indexing");
    gitlab.setInvalidMetadata(true);
    await assert.rejects(publish(root, gitlab, 3));
    assert.equal(await readFile(join(root, "current.json"), "utf8"), frozen);
    const { native, context } = setup(root, previous.snapshotRef, ["simulator-source", "estimate-source", "psp-source"]);
    assert.equal((await native.code.snippet(context("retained"), { repositoryRef: "simulator-source", snapshotRef: previous.snapshotRef,
      symbol: "simulator.runSimulator", file: "simulator.ts" })).evidence.length, 1);
  } finally { await gitlab.close(); await removeOwnedTree(root); }
});

for (const mode of ["coverage_empty", "coverage_duplicate", "coverage_unexpected"] as const) test(`management rejects ${mode} instead of publishing complete coverage`, { timeout: 60_000 }, async () => {
  const { dockerResultProxy } = await import("../fixtures/docker-result-proxy.js");
  const gitlab = await syntheticGitLab(), root = await mkdtemp(join(tmpdir(), "bau-coverage-exact-"));
  try {
    const docker = await dockerResultProxy(root, mode), config = join(root, "bad-coverage.json");
    await writeFile(config, JSON.stringify({ mode: "local_synthetic", root, ...profile, docker, gitlab: gitlab.url, repositories: gitlab.repositories.slice(0, 1) }));
    await assert.rejects(execute(process.execPath, [cli, config], { timeout: 45_000, maxBuffer: 16_384 }));
    await assert.rejects(access(join(root, "current.json"))); await assert.rejects(access(join(root, "update.lock")));
    assert.deepEqual(await readdir(join(root, "collections")), []);
  } finally { await gitlab.close(); await removeOwnedTree(root); }
});

test("non-root post-freeze publication failure removes its owned staging tree and releases the confirmed-stopped writer lock", { timeout: 90_000 }, async () => {
  assert.notEqual(process.getuid?.(), 0, "The controller must exercise real non-root directory permissions.");
  const { mkdir, rename } = await import("node:fs/promises");
  const gitlab = await syntheticGitLab(), root = await mkdtemp(join(tmpdir(), "bau-post-freeze-"));
  try {
    const previous = await publish(root, gitlab), original = await readFile(join(root, "current.json"), "utf8");
    await rename(join(root, "current.json"), join(root, "last-successful.json")); await mkdir(join(root, "current.json"));
    await assert.rejects(publish(root, gitlab));
    await assert.rejects(access(join(root, "update.lock")));
    assert.deepEqual(await readdir(join(root, "collections")), [previous.snapshotRef]);
    await rm(join(root, "current.json"), { recursive: true }); await rename(join(root, "last-successful.json"), join(root, "current.json"));
    assert.equal(await readFile(join(root, "current.json"), "utf8"), original);
    const next = await publish(root, gitlab); assert.notEqual(next.snapshotRef, previous.snapshotRef);
  } finally { await gitlab.close(); await removeOwnedTree(root); }
});

test("B three-repository trace cannot substitute another approved destination for the requested target", { timeout: 60_000 }, async () => {
  const { dockerResultProxy } = await import("../fixtures/docker-result-proxy.js");
  const gitlab = await syntheticGitLab(), root = await mkdtemp(join(tmpdir(), "bau-targeted-trace-"));
  try {
    const receipt = await publish(root, gitlab, 3), docker = await dockerResultProxy(root, "trace_other_target");
    const collection = new SnapshotCollection(root);
    const { native, context } = setup(root, receipt.snapshotRef, ["simulator-source", "estimate-source", "psp-source"], localReadService({ ...profile, docker }, (snapshot) => collection.path(snapshot)));
    const read = await native.code.trace(context("requested-B-returned-C"), { repositoryRef: "simulator-source", snapshotRef: receipt.snapshotRef,
      symbol: "simulator.requestEstimate", file: "simulator.ts", direction: "outbound", targetRepositoryRef: "estimate-source" });
    assert.equal(read.completeness, "unknown"); assert.equal(read.evidence.some((item) => item.code?.repositoryRef === "psp-source"), false);
    assert.match(read.warnings.join(" "), /destination|target/);
  } finally { await gitlab.close(); await removeOwnedTree(root); }
});
