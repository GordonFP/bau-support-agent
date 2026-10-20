// Host-only compilation of a fixed Git tree. Never imports application code.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, symlink, lstat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function prepareImageSource(output) {
  if (!isAbsolute(output ?? "") || process.versions.node !== "24.22.0") throw new Error("source_unverified");
  const compiler = JSON.parse(await readFile(join(root, "node_modules/typescript/package.json"), "utf8"));
  if (compiler.version !== "7.0.2") throw new Error("source_unverified");
  const sourceCommit = (await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("source_unverified");
  await mkdir(output, { mode: 0o700 }); // New owned directory; never reuse host dist or an earlier build.
  const archive = join(output, "source.tar"), tree = join(output, "tree");
  await execute("git", ["archive", "--format=tar", "--output", archive, sourceCommit], { cwd: root });
  await mkdir(tree, { mode: 0o700 });
  await execute("/usr/bin/tar", ["-xf", archive, "-C", tree]);
  // Exact existing compiler/declarations are tooling only. Docker installs Linux runtime dependencies from the archived lock.
  await symlink(join(root, "node_modules"), join(tree, "node_modules"), "dir");
  const compiled = await execute("npm", ["run", "build"], { cwd: tree, timeout: 60000, maxBuffer: 2097152 });
  await writeFile(join(output, "build.log"), compiled.stdout + compiled.stderr);
  const applicationFiles = [];
  const dist = join(tree, "dist/src");
  const visit = async (directory) => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), stat = await lstat(path);
      if (stat.isDirectory()) await visit(path);
      else {
        if (!stat.isFile() || !name.endsWith(".js")) throw new Error("source_unverified");
        applicationFiles.push({ path: relative(dist, path), bytes: stat.size, sha256: hash(await readFile(path)) });
      }
    }
  };
  for (const directory of ["adapters", "bootstrap", "troubleshooting"]) await visit(join(dist, directory));
  const receipt = { sourceCommit, sourceArchiveSha256: hash(await readFile(archive)), nodeVersion: process.versions.node,
    compilerVersion: compiler.version, applicationFiles };
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  return { ...receipt, tree };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("source_unverified");
    process.stdout.write(`${JSON.stringify(await prepareImageSource(process.argv[2]))}\n`);
  } catch { process.stderr.write("image_source_unverified\n"); process.exitCode = 1; }
}
