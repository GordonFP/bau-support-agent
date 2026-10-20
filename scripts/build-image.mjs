// Administrator build tool. No registry push, deployment or runtime import.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const docker = "/usr/local/bin/docker";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const run = async (command, args, maximum = 2097152) => (await execute(command, args, { cwd: root, maxBuffer: maximum, timeout: 180000 })).stdout;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  const output = process.argv[2];
  if (process.argv.length !== 3 || !isAbsolute(output ?? "") || process.versions.node !== "24.22.0") throw new Error("invalid_request");
  if ((await run("git", ["status", "--porcelain=v1"])).trim()) throw new Error("clean_source_required");
  const sourceCommit = (await run("git", ["rev-parse", "HEAD"])).trim();
  await mkdir(output, { mode: 0o700 }); // New owned artifact directory; never overwrite evidence.
  await writeFile(join(output, "build.log"), await run("npm", ["run", "build"]));
  const built = await execute(docker, ["build", "--pull=false", "--platform", "linux/arm64", "--progress=plain",
    "--label", `org.opencontainers.image.revision=${sourceCommit}`, "--tag", "bau-support-agent:issue-28-local", "."],
    { cwd: root, maxBuffer: 2097152, timeout: 180000 });
  await writeFile(join(output, "docker-build.log"), built.stdout + built.stderr);
  const inspect = JSON.parse(await run(docker, ["image", "inspect", "bau-support-agent:issue-28-local"]))[0];
  if (inspect.Os !== "linux" || inspect.Architecture !== "arm64" || !/^sha256:[a-f0-9]{64}$/.test(inspect.Id)) throw new Error("contract_unverified");
  await writeFile(join(output, "docker-inspect.json"), JSON.stringify(inspect, null, 2));
  const archive = join(output, "docker-save.tar");
  await run(docker, ["image", "save", "--output", archive, inspect.Id]);
  const receipt = JSON.parse(await run("python3", [join(root, "scripts/image-oci.py"), archive, join(output, "oci"), inspect.Id]));
  if (JSON.stringify(receipt.orderedDiffIds) !== JSON.stringify(inspect.RootFS.Layers)) throw new Error("contract_unverified");
  const inventory = await run(docker, ["run", "--rm", "--pull=never", "--init", "--network", "none", "--read-only", "--user", "1000:1000",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--cpus", "1", "--memory", "512m", "--pids-limit", "64",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--mount", `type=bind,src=${join(root, "scripts/image-inventory.mjs")},dst=/checks/inventory.mjs,readonly`,
    "--entrypoint", "node", inspect.Id, "/checks/inventory.mjs"], 16777216);
  await writeFile(join(output, "inventory.json"), inventory);
  const result = { ...receipt, sourceCommit, lockSha256: hash(await readFile(join(root, "package-lock.json"))),
    skillSha256: hash(await readFile(join(root, "runtime-skills/bau-troubleshooting/SKILL.md"))), inventorySha256: hash(inventory),
    buildScope: "local_synthetic_linux_arm64_no_registry_upload", imageTag: "bau-support-agent:issue-28-local" };
  await writeFile(join(output, "receipt.json"), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error instanceof Error && error.message === "clean_source_required" ? "clean_source_required" : "image_build_unverified"}\n`); process.exitCode = 1; }
