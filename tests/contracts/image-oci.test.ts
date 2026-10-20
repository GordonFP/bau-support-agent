import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, link, mkdir, writeFile, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const execute = promisify(execFile);
const script = resolve("scripts/image-oci.py");
const source = process.env.BAU_OCI_LAYOUT;
const verify = (root: string) => execute("python3", [script, "verify", root], { maxBuffer: 1048576, timeout: 20000 });

test("the actual local OCI content chain maps to the independently inspected runnable Docker config and ordered DiffIDs", async () => {
  assert.ok(source, "An actual converted image layout is required; no fixture fallback.");
  const receipt = JSON.parse((await verify(source)).stdout) as {dockerConfigId: string; orderedDiffIds: string[]; imageManifestDigest: string; indexDigest: string};
  assert.equal(receipt.dockerConfigId, process.env.BAU_CONTAINER_IMAGE);
  assert.notEqual(receipt.imageManifestDigest, receipt.dockerConfigId); assert.notEqual(receipt.indexDigest, receipt.imageManifestDigest);
  const inspect = JSON.parse((await execute("/usr/local/bin/docker", ["image", "inspect", receipt.dockerConfigId], { maxBuffer: 1048576 })).stdout)[0] as {Id: string; RootFS: {Layers: string[]}; Architecture: string; Os: string};
  assert.equal(inspect.Id, receipt.dockerConfigId); assert.deepEqual(inspect.RootFS.Layers, receipt.orderedDiffIds);
  assert.equal(inspect.Os, "linux"); assert.equal(inspect.Architecture, "arm64");
});

test("the public artifact verifier refuses missing/corrupt blobs, wrong descriptor size/platform and reordered layers", async () => {
  assert.ok(source);
  for (const kind of ["missing", "corrupt", "size", "platform", "order"]) {
    const root = await mkdtemp(join(tmpdir(), "bau-oci-negative-"));
    try {
      await mkdir(join(root, "blobs", "sha256"), { recursive: true });
      await writeFile(join(root, "oci-layout"), await readFile(join(source, "oci-layout")));
      const index = JSON.parse(await readFile(join(source, "index.json"), "utf8"));
      for (const name of await readdir(join(source, "blobs", "sha256"))) await link(join(source, "blobs", "sha256", name), join(root, "blobs", "sha256", name));
      const selected = index.manifests[0] as {digest: string; size: number; platform: {architecture: string}};
      const manifestPath = join(root, "blobs", "sha256", selected.digest.slice(7));
      if (kind === "missing") await unlink(manifestPath);
      if (kind === "corrupt") { await unlink(manifestPath); await writeFile(manifestPath, "{}"); }
      if (kind === "size") selected.size++;
      if (kind === "platform") selected.platform.architecture = "amd64";
      if (kind === "order") {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")); manifest.layers.reverse();
        const bytes = Buffer.from(JSON.stringify(manifest)); selected.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`; selected.size = bytes.length;
        await writeFile(join(root, "blobs", "sha256", selected.digest.slice(7)), bytes);
      }
      await writeFile(join(root, "index.json"), JSON.stringify(index));
      await assert.rejects(verify(root), (error: unknown) => { assert.equal((error as {stderr: string}).stderr.trim(), "image_artifact_unverified"); return true; });
      if (kind === "size") await assert.rejects(execute("python3", [script, "verify", root], {
        env: { ...process.env, PYTHONOPTIMIZE: "1" }, maxBuffer: 1048576, timeout: 20000,
      }), (error: unknown) => { assert.equal((error as {stderr: string}).stderr.trim(), "image_artifact_unverified"); return true; });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  await verify(source); // Negative copies never modified the original linked blobs.
});
