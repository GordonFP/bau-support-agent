// Host-mounted verification program; never copied into the application image.
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const sha = async (path) => {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex");
};
const files = async (root, select = () => true) => {
  const output = [];
  const visit = async (directory) => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), stat = await lstat(path);
      if (stat.isDirectory()) await visit(path);
      else if ((stat.isFile() || stat.isSymbolicLink()) && select(path)) {
        const resolved = await realpath(path), target = await lstat(resolved);
        if (target.isFile()) output.push({ path: relative(root, path), bytes: target.size, sha256: await sha(resolved) });
      }
    }
  };
  await visit(root); return output;
};
const lock = JSON.parse(await readFile("/app/package-lock.json", "utf8"));
const packageFiles = await files("/app/node_modules");
const packages = [];
for (const item of packageFiles.filter((item) => /(^|\/)package.json$/.test(item.path))) {
  const path = `node_modules/${item.path.slice(0, -13)}`.replace(/\/$/, "");
  const pinned = lock.packages[path];
  if (!pinned) continue; // Nested package resources are inventoried but are not installation roots.
  const installed = JSON.parse(await readFile(`/app/${path}/package.json`, "utf8"));
  assert.equal(installed.version, pinned.version); assert.notEqual(pinned.dev, true);
  packages.push({ path, name: installed.name, version: installed.version, license: installed.license ?? null,
    resolved: pinned.resolved, integrity: pinned.integrity, installedManifestSha256: item.sha256 });
}
const supplemental = JSON.parse(await readFile("/app/notices/provenance.json", "utf8"));
for (const item of supplemental.texts) {
  assert.equal(await sha(`/app/notices/${item.file}`), item.sha256);
  assert.ok(packages.some((pkg) => pkg.name === item.name && pkg.version === item.version), `Supplemental notice package not installed: ${item.name}`);
}
const baseNotices = [];
for (const root of ["/usr/share/doc", "/usr/local/lib/node_modules", "/opt"]) {
  for (const item of await files(root, (path) => /(^|\/)(copyright|licen[cs]e[^/]*|copying[^/]*|notice[^/]*)$/i.test(path))) baseNotices.push({ ...item, path: `${root}/${item.path}` });
}
for (const item of await files("/usr/share/common-licenses")) baseNotices.push({ ...item, path: `/usr/share/common-licenses/${item.path}` });
baseNotices.push({ path: "/usr/local/LICENSE", bytes: (await lstat("/usr/local/LICENSE")).size, sha256: await sha("/usr/local/LICENSE") });
const dpkg = execFileSync("/usr/bin/dpkg-query", ["-W", "-f=${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n"], { encoding: "utf8", maxBuffer: 1048576 });
const basePackages = [];
for (const row of dpkg.trim().split("\n").map((row) => row.split("\t"))) {
  const copyright = `/usr/share/doc/${row[0].split(":")[0]}/copyright`;
  const notice = { path: copyright, bytes: (await lstat(await realpath(copyright))).size, sha256: await sha(copyright) };
  if (!baseNotices.some((item) => item.path === copyright)) baseNotices.push(notice);
  basePackages.push({ package: row[0], version: row[1], architecture: row[2], source: row[3], sourceVersion: row[4], copyright: notice });
}
const applicationFiles = await files("/app/dist/src");
assert.ok(applicationFiles.every((item) => /^(adapters|bootstrap|troubleshooting)\//.test(item.path)));
process.stdout.write(JSON.stringify({ schemaVersion: 1, platform: { os: process.platform, arch: process.arch, versions: process.versions },
  lockSha256: await sha("/app/package-lock.json"), packages, packageFileCount: packageFiles.length, packageFiles, applicationFiles,
  supplemental, basePackages, baseNotices,
  limits: ["Installed files and npm-enforced lock SRI are distinct evidence; not a reproducible publisher build or signature claim.",
    "Actual included notices are retained; unresolved grant/applicability/source-material questions are not cleared.",
    "No complete final vulnerability or legal clearance is implied."] }, null, 2));
