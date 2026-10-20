import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { z } from "zod/v4";
import { McpFailure } from "../mcp/failure.js";
import { digest } from "../mcp/manifest.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const repository = z.strictObject({ repositoryRef: ref, project: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  branch: z.enum(["main", "master"]), commit: z.string().regex(/^[a-f0-9]{40}$/), indexedAt: z.iso.datetime(),
  sourceSha256: hash, databaseSha256: hash, files: z.array(z.string().regex(/^[a-zA-Z0-9_/-]+\.[a-zA-Z0-9]+$/)).min(1).max(10000) });
const receipt = z.strictObject({ schemaVersion: z.literal(1), snapshotRef: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  artifactVersion: z.literal("0.12.1"), artifactSha256: z.literal("6a64e20e2ca8dc15b4a412e981e5aea60804ed3e952d693ab491c93ccd36ed45"),
  publishedAt: z.iso.datetime(), repositories: z.array(repository).min(1).max(3),
  crossRepository: z.strictObject({ status: z.literal("complete"), projects: z.array(z.string()).min(1).max(3), receiptSha256: hash }),
  receiptSha256: hash });
export type CollectionReceipt = z.infer<typeof receipt>;
export type RepositoryReceipt = CollectionReceipt["repositories"][number];
export const binarySha256 = "6a64e20e2ca8dc15b4a412e981e5aea60804ed3e952d693ab491c93ccd36ed45";
export function parseReceipt(value: unknown): CollectionReceipt {
  const parsed = receipt.safeParse(value);
  if (!parsed.success) throw new McpFailure("version_unknown");
  const result = parsed.data;
  const { receiptSha256, ...body } = result;
  if (digest(body) !== receiptSha256 || new Set(result.repositories.map((item) => item.repositoryRef)).size !== result.repositories.length ||
    new Set(result.repositories.map((item) => item.project)).size !== result.repositories.length ||
    JSON.stringify(result.crossRepository.projects) !== JSON.stringify(result.repositories.map((item) => item.project)) ||
    result.repositories.some((item) => item.files.some((file) => file.split("/").some((part) => part === "." || part === ".." || !part)))) throw new McpFailure("version_mismatch");
  return result;
}
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 65_536 })) hash.update(chunk);
  return hash.digest("hex");
}
export async function sourceDigest(root: string): Promise<{ sha256: string; files: string[] }> {
  const entries: { file: string; sha256: string }[] = [];
  const visit = async (relative: string) => {
    const directory = join(root, relative);
    for (const name of (await readdir(directory)).sort()) {
      if (!relative && name === ".git") continue;
      const file = relative ? `${relative}/${name}` : name;
      const stat = await lstat(join(root, file));
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new McpFailure("version_mismatch");
      if (stat.isDirectory()) await visit(file);
      else {
        if (entries.length >= 10000 || stat.size > 1_048_576) throw new McpFailure("invalid_request");
        entries.push({ file, sha256: await fileSha256(join(root, file)) });
      }
    }
  };
  await visit("");
  return { sha256: digest(entries), files: entries.map((item) => item.file) };
}

// A disk lease is shared by the independent management CLI and read process.
// Unknown/still-running reads retain their lease; administrative intervention is required after a crash.
export class SnapshotCollection {
  readonly root: string;
  constructor(root: string) {
    if (!isAbsolute(root)) throw new McpFailure("contract_unverified");
    this.root = root;
  }
  path(snapshotRef: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(snapshotRef)) throw new McpFailure("invalid_request");
    return join(this.root, "collections", snapshotRef);
  }
  async lease(snapshotRef: string): Promise<{ receipt: CollectionReceipt; release(): Promise<void>; verify(): Promise<void> }> {
    const paused = async () => { try { await lstat(join(this.root, "update.lock")); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
    if (await paused()) throw new McpFailure("unavailable");
    await mkdir(join(this.root, "readers"), { recursive: true });
    const path = join(this.root, "readers", randomUUID());
    await writeFile(path, snapshotRef, { flag: "wx", mode: 0o600 });
    try {
      if (await paused()) throw new McpFailure("unavailable");
      const selected = parseReceipt(JSON.parse(await readFile(join(this.root, "current.json"), "utf8")));
      if (selected.snapshotRef !== snapshotRef) throw new McpFailure("version_mismatch");
      const published = parseReceipt(JSON.parse(await readFile(join(this.path(snapshotRef), "receipt.json"), "utf8")));
      if (selected.receiptSha256 !== published.receiptSha256) throw new McpFailure("version_mismatch");
      const verify = async () => {
        const current = parseReceipt(JSON.parse(await readFile(join(this.path(snapshotRef), "receipt.json"), "utf8")));
        if (current.receiptSha256 !== selected.receiptSha256) throw new McpFailure("version_mismatch");
        if (digest(JSON.parse(await readFile(join(this.path(snapshotRef), "proof.json"), "utf8"))) !== selected.crossRepository.receiptSha256) throw new McpFailure("version_mismatch");
        for (const repository of selected.repositories) {
          const source = await sourceDigest(join(this.path(snapshotRef), "sources", repository.repositoryRef));
          if (source.sha256 !== repository.sourceSha256 || JSON.stringify(source.files) !== JSON.stringify(repository.files) ||
            await fileSha256(join(this.path(snapshotRef), "databases", `${repository.project}.db`)) !== repository.databaseSha256) throw new McpFailure("version_mismatch");
        }
      };
      await verify();
      return { receipt: selected, release: () => rm(path, { force: true }), verify };
    } catch (error) { await rm(path, { force: true }); throw error instanceof McpFailure ? error : new McpFailure("version_unknown"); }
  }
}
