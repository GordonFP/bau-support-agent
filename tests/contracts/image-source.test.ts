import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, mkdir, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

const execute = promisify(execFile);
test("canonical tracked-source compilation excludes both ignored extra TypeScript and stale compiled JavaScript, matching the actual image byte for byte", { timeout: 30000 }, async () => {
  assert.ok(process.env.BAU_IMAGE_INVENTORY, "Actual image inventory is required, not a synthetic source fixture.");
  const temporary = await mkdtemp(join(tmpdir(), "bau-source-contract-"));
  const name = `image-canary-${randomUUID()}`;
  const ignored = resolve(`src/bootstrap/${name}.ts`), stale = resolve(`dist/src/bootstrap/${name}-stale.js`);
  try {
    await mkdir(resolve("dist/src/bootstrap"), { recursive: true });
    await writeFile(ignored, "export const sourceCanary = 'UNTRACKED_IMAGE_SOURCE_CANARY';\n");
    await writeFile(stale, "export const staleCanary = 'STALE_IMAGE_OUTPUT_CANARY';\n");
    const exclude = join(temporary, "ignore"); await writeFile(exclude, `/src/bootstrap/${name}.ts\n`);
    const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: exclude };
    const status = (await execute("git", ["status", "--porcelain=v1"], { env })).stdout;
    assert.equal(status.includes(name), false); // A clean-status check cannot catch these inputs.
    const result = await execute(process.execPath, [resolve("scripts/image-source.mjs"), join(temporary, "source")], { env, timeout: 20000, maxBuffer: 1048576 });
    const prepared = JSON.parse(result.stdout) as {sourceCommit: string; applicationFiles: {path: string; sha256: string; bytes: number}[]};
    assert.equal(prepared.sourceCommit, (await execute("git", ["rev-parse", "HEAD"])).stdout.trim());
    assert.ok(prepared.applicationFiles.length > 0); assert.equal(prepared.applicationFiles.some((item) => item.path.includes(name)), false);
    const inventory = JSON.parse(await readFile(process.env.BAU_IMAGE_INVENTORY!, "utf8")) as {applicationFiles: typeof prepared.applicationFiles};
    assert.deepEqual(prepared.applicationFiles, inventory.applicationFiles);
  } finally { await unlink(ignored); await unlink(stale); await rm(temporary, { recursive: true, force: true }); }
});
