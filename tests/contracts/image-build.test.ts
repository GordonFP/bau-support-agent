import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
test("image build exports its own immutable ID when another build replaces the shared tag with different image inputs", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-build-interleave-")), calls = join(directory, "docker-calls.jsonl"), docker = join(directory, "docker.mjs"), output = join(directory, "artifact");
  const own = `sha256:${"a".repeat(64)}`, other = `sha256:${"b".repeat(64)}`;
  const commit = (await execute("git", ["rev-parse", "HEAD"])).stdout.trim();
  try {
    await writeFile(docker, `#!${process.execPath}
import {appendFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2),own=${JSON.stringify(own)},other=${JSON.stringify(other)};
appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]==='build'){
 const iid=args.indexOf('--iidfile');if(iid>=0)writeFileSync(args[iid+1],own+'\\n');
 // Another concurrent build now replaces the shared tag. Its JS is unchanged; its dependency/Skill inputs differ.
 process.stdout.write('synthetic overlapping build finished\\n');
}else if(args[0]==='image'&&args[1]==='inspect')process.stdout.write(JSON.stringify([{Id:args[2]===own?own:other,Os:'linux',Architecture:'arm64',RootFS:{Layers:[]},Config:{Labels:{'org.opencontainers.image.revision':args[2]===own?${JSON.stringify(commit)}:'${"b".repeat(40)}'}}}]));
else if(args[0]==='image'&&args[1]==='save')process.exitCode=1; // Stop before OCI conversion: no synthetic archive can pass as an actual image.
else process.exitCode=1;
`); await chmod(docker, 0o755);
    await assert.rejects(execute(process.execPath, [resolve("scripts/build-image.mjs"), output], { env: { ...process.env, BAU_IMAGE_DOCKER: docker }, timeout: 15_000 }));
    const observed = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(observed[0]!.includes("--iidfile"));
    assert.deepEqual(observed.find((args) => args[0] === "image" && args[1] === "inspect"), ["image", "inspect", own]);
    assert.equal(observed.find((args) => args[0] === "image" && args[1] === "save")?.at(-1), own);
    await assert.rejects(readFile(join(output, "receipt.json")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
