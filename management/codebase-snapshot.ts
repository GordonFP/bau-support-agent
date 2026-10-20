import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { BoundedStdio } from "../src/adapters/mcp/stdio.js";
import { digest } from "../src/adapters/mcp/manifest.js";
import { binarySha256, fileSha256, parseReceipt, sourceDigest, type CollectionReceipt, type RepositoryReceipt } from "../src/adapters/codebase-memory/collection.js";
import { nativePayload, object } from "../src/adapters/codebase-memory/native-result.js";
import { ownedContainer, researchImage } from "./codebase-docker.js";

const configSchema = z.strictObject({ mode: z.literal("local_synthetic"), root: z.string().refine(isAbsolute),
  docker: z.string().refine(isAbsolute), binary: z.string().refine(isAbsolute), image: z.literal(researchImage),
  gitlab: z.string().url(), repositories: z.array(z.strictObject({ repositoryRef: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    project: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), projectId: z.number().int().positive(), branch: z.enum(["main", "master"]) })).min(1).max(3) });
const execute = promisify(execFile);
async function freeze(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await freeze(path);
    else await chmod(path, 0o444);
  }
  await chmod(root, 0o555);
}
export async function publishSnapshot(rawConfig: unknown): Promise<CollectionReceipt> {
  const config = configSchema.parse(rawConfig);
  const remote = new URL(config.gitlab);
  if (remote.protocol !== "http:" || remote.hostname !== "127.0.0.1" || !remote.port || remote.username || remote.password ||
    remote.pathname !== "/" || remote.search || remote.hash ||
    new Set(config.repositories.map((item) => item.repositoryRef)).size !== config.repositories.length ||
    new Set(config.repositories.map((item) => item.project)).size !== config.repositories.length ||
    new Set(config.repositories.map((item) => item.projectId)).size !== config.repositories.length) throw new Error("invalid_request");
  if (await fileSha256(config.binary) !== binarySha256) throw new Error("contract_unverified");
  await mkdir(config.root, { recursive: true, mode: 0o700 });
  const lock = join(config.root, "update.lock");
  await mkdir(lock); // One independent writer; existing/unknown writer is never displaced.
  const snapshotRef = `cbm-${randomUUID()}`;
  const stage = join(config.root, "collections", snapshotRef);
  let container: ReturnType<typeof ownedContainer> | undefined;
  let published = false;
  let phase: "draining" | "synchronizing" | "indexing" | "cross_repository" | "provenance" | "exporting" | "stopping" | "freezing" = "draining";
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, snapshotRef }), { mode: 0o600 });
    const deadline = Date.now() + 30_000;
    for (;;) {
      let readers: string[];
      try { readers = await readdir(join(config.root, "readers")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; readers = []; }
      if (!readers.length) break;
      if (Date.now() >= deadline) throw new Error("timeout");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await mkdir(join(stage, "sources"), { recursive: true });
    await mkdir(join(stage, "databases"));
    phase = "synchronizing";
    const commits = new Map<string, { commit: string; source: Awaited<ReturnType<typeof sourceDigest>> }>();
    for (const repository of config.repositories) {
      const response = await fetch(new URL(`api/v4/projects/${repository.projectId}/repository/branches/${repository.branch}`, remote),
        { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok || Number(response.headers.get("content-length")) > 16_384) throw new Error("unavailable");
      if (!response.body) throw new Error("unavailable");
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          length += next.value.byteLength;
          if (length > 16_384) { await reader.cancel(); throw new Error("unsafe_content"); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const branch = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
      const commit = object(branch.commit).id;
      if (branch.name !== repository.branch || typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("version_mismatch");
      const path = join(stage, "sources", repository.repositoryRef);
      const git = async (args: string[]) => (await execute("/usr/bin/git", ["-c", "protocol.allow=never", "-c", "protocol.http.allow=always",
        "-c", "http.followRedirects=false", ...args], { env: { LANG: "C.UTF-8", TZ: "UTC", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: 16_384, timeout: 5000 })).stdout.trim();
      await git(["clone", "--single-branch", "--no-tags", "--branch", repository.branch, new URL(`repos/${repository.projectId}.git`, remote).href, path]);
      if (await git(["-C", path, "rev-parse", "HEAD"]) !== commit || await git(["-C", path, "branch", "--show-current"]) !== repository.branch ||
        await git(["-C", path, "status", "--porcelain"])) throw new Error("version_mismatch");
      const source = await sourceDigest(path);
      if (source.files.some((file) => file.startsWith(".codebase-memory/") || file === ".gitmodules")) throw new Error("invalid_request");
      commits.set(repository.repositoryRef, { commit, source });
    }
    phase = "indexing";
    container = ownedContainer(config, join(stage, "sources"), config.repositories);
    await container.open();
    const transport = new BoundedStdio(container.endpoint(true));
    const client = new Client({ name: "bau-independent-index-management", version: "1" }, { capabilities: {},
      jsonSchemaValidator: { getValidator: () => { throw new Error("schema_mismatch"); } } });
    client.onerror = () => {};
    const proof: { repositoryRef: string; operation: string; result: unknown }[] = [];
    const call = async (repositoryRef: string, name: string, args: Record<string, unknown>) => {
      const result = nativePayload(await client.callTool({ name, arguments: args }, undefined,
        { timeout: 30_000, maxTotalTimeout: 30_000, resetTimeoutOnProgress: false }));
      transport.assertComplete();
      proof.push({ repositoryRef, operation: name, result });
      return result;
    };
    const repositories: RepositoryReceipt[] = [];
    try {
      await client.connect(transport, { timeout: 5000, maxTotalTimeout: 5000 });
      if (client.getServerVersion()?.name !== "codebase-memory-mcp" || client.getServerVersion()?.version !== "0.12.1") throw new Error("contract_unverified");
      for (const repository of config.repositories) {
        const result = await call(repository.repositoryRef, "index_repository", { repo_path: `/repos/${repository.repositoryRef}`, name: repository.project, mode: "fast", persistence: false });
        if (result.status !== "indexed" || result.project !== repository.project ||
          ["not_indexed_files_count", "skipped_count", "parse_partial_count", "parse_unusable_count"].some((field) => result[field] !== 0) ||
          typeof result.nodes !== "number" || result.nodes <= 0 || result.nodes !== result.expected_nodes || result.edges !== result.expected_edges) throw new Error("contract_unverified");
      }
      phase = "cross_repository";
      if (config.repositories.length > 1) for (const repository of config.repositories) {
        const targets = config.repositories.filter((item) => item.project !== repository.project).map((item) => item.project);
        const result = await call(repository.repositoryRef, "index_repository", { repo_path: `/repos/${repository.repositoryRef}`, name: repository.project,
          mode: "cross-repo-intelligence", target_projects: targets, persistence: false });
        if (result.status !== "success" || result.project !== repository.project || result.projects_scanned !== targets.length ||
          result.partial_results === true || (Array.isArray(result.skipped_projects) && result.skipped_projects.length)) throw new Error("contract_unverified");
      }
      phase = "provenance";
      for (const repository of config.repositories) {
        const expected = commits.get(repository.repositoryRef)!;
        const metadata = await call(repository.repositoryRef, "query_graph", { project: repository.project,
          query: "MATCH (b:Branch) RETURN b.name, b.head_sha", format: "json", max_rows: 5, max_output_tokens: 1500 });
        if (JSON.stringify(metadata.columns) !== JSON.stringify(["b.name", "b.head_sha"]) ||
          JSON.stringify(metadata.rows) !== JSON.stringify([[repository.branch, expected.commit]])) throw new Error("version_mismatch");
        const status = await call(repository.repositoryRef, "index_status", { project: repository.project, verbose: true, diagnostics: "full", format: "json" });
        const coverage = await call(repository.repositoryRef, "check_index_coverage", { project: repository.project, paths: expected.source.files.filter((file) => /\.(ts|js|py)$/.test(file)), format: "json" });
        const recorded = object(coverage.metadata);
        if (status.status !== "ready" || !z.iso.datetime().safeParse(status.indexed_at).success ||
          recorded.recording_status !== "complete" || recorded.hash_records_complete !== true || recorded.generation_matches !== true ||
          coverage.path_has_more !== false || !Array.isArray(coverage.paths) || coverage.paths.some((path) => object(path).freshness !== "metadata_match")) throw new Error("contract_unverified");
        const source = await sourceDigest(join(stage, "sources", repository.repositoryRef));
        if (source.sha256 !== expected.source.sha256) throw new Error("version_mismatch");
        repositories.push({ repositoryRef: repository.repositoryRef, project: repository.project, branch: repository.branch, commit: expected.commit,
          indexedAt: status.indexed_at as string, sourceSha256: source.sha256, databaseSha256: "", files: source.files });
      }
    } finally { await transport.close(); await client.close(); }
    phase = "exporting";
    // A closed MCP frontend alone is not a quiescent SQLite producer. Confirm
    // the private namespace has no native frontend/daemon/writer before copying DB bytes.
    await container.command(["node", "-e", `const fs=require('node:fs');
      const active=()=>fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)).some(x=>{
        try{return fs.readFileSync('/proc/'+x+'/comm','utf8').trim().startsWith('codebase-memory');}catch{return false;}
      });
      const end=Date.now()+4000;const check=()=>{if(!active())return; if(Date.now()>=end)process.exit(1);else setTimeout(check,10);};check();`]);
    for (const repository of repositories) {
      const database = await container.command(["cat", `/state/cache/${repository.project}.db`], 64 * 1_048_576);
      await writeFile(join(stage, "databases", `${repository.project}.db`), database, { mode: 0o444 });
      repository.databaseSha256 = await fileSha256(join(stage, "databases", `${repository.project}.db`));
    }
    phase = "stopping";
    await container.close();
    phase = "freezing";
    const body = { schemaVersion: 1 as const, snapshotRef, artifactVersion: "0.12.1" as const, artifactSha256: binarySha256,
      publishedAt: new Date().toISOString(), repositories, crossRepository: { status: "complete" as const,
        projects: repositories.map((item) => item.project), receiptSha256: digest(proof) } };
    const receipt = parseReceipt({ ...body, receiptSha256: digest(body) });
    await writeFile(join(stage, "proof.json"), JSON.stringify(proof));
    await writeFile(join(stage, "receipt.json"), JSON.stringify(receipt));
    await freeze(stage);
    const pending = join(config.root, `current-${randomUUID()}.json`);
    await writeFile(pending, JSON.stringify(receipt), { mode: 0o444, flag: "wx" });
    await rename(pending, join(config.root, "current.json"));
    published = true;
    return receipt;
  } catch (error) {
    await writeFile(join(config.root, `failed-${snapshotRef}.json`), JSON.stringify({ snapshotRef, status: "failed", phase, reason: error instanceof Error &&
      ["timeout", "version_mismatch", "contract_unverified", "invalid_request"].includes(error.message) ? error.message : "unavailable" }), { mode: 0o600 });
    throw error;
  } finally {
    // Never unpause readers while an unknown management process may still write.
    await container?.close();
    if (!published) await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("invalid_request");
    const configPath = process.argv[2]!;
    if (!isAbsolute(configPath)) throw new Error("invalid_request");
    const receipt = await publishSnapshot(JSON.parse(await readFile(configPath, "utf8")));
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch { process.stderr.write("snapshot_publication_failed\n"); process.exitCode = 1; }
}
