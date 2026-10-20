// G1 local management/test controller. Never imported by the production BAU runtime.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { StdioEndpoint } from "../src/adapters/mcp/stdio.js";
import { binarySha256, fileSha256, type CollectionReceipt } from "../src/adapters/codebase-memory/collection.js";

const execute = promisify(execFile);
export const researchImage = "sha256:df76f23de89b7a36c1ada0f9a5b8d14e63169547479eaef955cc0e7c74d6e29a";
export interface DockerProfile { readonly docker: string; readonly binary: string; readonly image: typeof researchImage }
const environment = { LANG: "C.UTF-8", TZ: "UTC" };
export async function dockerCommand(profile: DockerProfile, args: readonly string[], maxBuffer = 16_384): Promise<Buffer> {
  const result = await execute(profile.docker, [...args], { env: environment, encoding: "buffer", maxBuffer, timeout: 5000 });
  return result.stdout;
}
export function ownedContainer(profile: DockerProfile, sourceRoot: string, configuredRepositories?: readonly { repositoryRef: string; project: string }[], databaseRoot?: string) {
  if (!isAbsolute(profile.docker) || !isAbsolute(profile.binary) || profile.image !== researchImage) throw new Error("contract_unverified");
  const name = `bau-cbm-owned-${randomUUID()}`;
  let start: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let retired = false;
  let creationRequested = false;
  const close = () => closing ??= (async () => {
    retired = true;
    if (!start) return;
    // A delayed start is still owned. Never report success before its original promise settles.
    let unknownStart = false;
    try { await start; } catch {
      if (!creationRequested) return; // Local validation failed before any create request.
      unknownStart = true;
    }
    try { await dockerCommand(profile, ["rm", "--force", name]); } catch { /* inspect below is authoritative */ }
    try { await dockerCommand(profile, ["inspect", "--format", "{{.State.Running}}", name]); }
    catch (error) {
      if (!unknownStart && String((error as { stderr?: Buffer }).stderr).trim().toLowerCase() === `error: no such object: ${name}`) return;
      throw new Error("unavailable");
    }
    throw new Error("unavailable");
  })();
  const open = (selected = configuredRepositories) => {
    if (retired && !start) return Promise.reject(new Error("cancelled"));
    return start ??= (async () => {
    const repositories = selected;
    if (!repositories?.length || repositories.length > 3) throw new Error("contract_unverified");
    if (await fileSha256(profile.binary) !== binarySha256) throw new Error("contract_unverified");
    const args = ["run", "--detach", "--init", "--name", name, "--network", "none", "--read-only", "--user", "1000:1000",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--cpus", "2", "--memory", "1536m", "--pids-limit", "128",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m", "--tmpfs", "/state/cache:rw,noexec,nosuid,size=512m,uid=1000,gid=1000",
      "--tmpfs", "/work:rw,noexec,nosuid,size=1m,uid=1000,gid=1000", "--workdir", "/work",
      "--mount", `type=bind,src=${profile.binary},dst=/artifact/codebase-memory-mcp,readonly`,
      "--env", "CBM_CACHE_DIR=/state/cache", "--env", "CBM_ALLOWED_ROOT=/repos", "--env", "CBM_WORKERS=1",
      "--env", "CBM_MEM_BUDGET_MB=512", "--env", "CBM_LOG_LEVEL=warn", "--env", "CBM_STARTUP_TIMEOUT_MS=1000",
      "--env", `GIT_CONFIG_COUNT=${repositories.length}`];
    for (const [index, repository] of repositories.entries()) {
      args.push("--mount", `type=bind,src=${join(sourceRoot, repository.repositoryRef)},dst=/repos/${repository.repositoryRef},readonly`,
        "--env", `GIT_CONFIG_KEY_${index}=safe.directory`, "--env", `GIT_CONFIG_VALUE_${index}=/repos/${repository.repositoryRef}`);
      if (databaseRoot) args.push("--mount", `type=bind,src=${join(databaseRoot, `${repository.project}.db`)},dst=/state/cache/${repository.project}.db,readonly`);
    }
    args.push(profile.image, "/bin/sleep", "infinity");
    // A failed/expired CLI cannot prove the daemon did not receive this request.
    // Even a currently absent name cannot exclude a late create. Keep cached
    // cleanup rejected and its reader lease held for independent reconciliation.
    creationRequested = true;
    await dockerCommand(profile, args);
  })(); };
  const endpoint = (management = false): StdioEndpoint & { close: () => Promise<void> } => ({ command: profile.docker,
    args: ["exec", "--interactive", name, "/artifact/codebase-memory-mcp", ...(management ? ["--ui=false"] : ["--tool-profile=analysis"])],
    artifact: { path: profile.binary, sha256: binarySha256 }, close });
  return { name, open, close, endpoint, command: (args: readonly string[], maximum?: number) => dockerCommand(profile, ["exec", name, ...args], maximum) };
}
export function localReadService(profile: DockerProfile, collectionRoot: (snapshotRef: string) => string) {
  return (snapshotRef: string) => {
    const root = collectionRoot(snapshotRef);
    const container = ownedContainer(profile, join(root, "sources"), undefined, join(root, "databases"));
    // The endpoint's owned name is known before receipt verification or startup awaits.
    return { endpoint: container.endpoint(), start: (receipt: CollectionReceipt) => {
      if (receipt.snapshotRef !== snapshotRef) return Promise.reject(new Error("version_mismatch"));
      return container.open(receipt.repositories);
    } };
  };
}
