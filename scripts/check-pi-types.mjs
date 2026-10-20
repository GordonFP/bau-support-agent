import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

// Vendor declaration bodies are skipped; consumer call-site types must still be enforced.
const directory = mkdtempSync(join(tmpdir(), "bau-pi-consumer-"));
try {
  const sdk = resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  const fixture = join(directory, "consumer.mts");
  const compiler = resolve("node_modules/typescript/bin/tsc");
  const compile = (tools) => {
    writeFileSync(fixture, `import { createAgentSession } from ${JSON.stringify(sdk)};\nvoid createAgentSession({ tools: [${tools}] });\n`);
    return spawnSync(process.execPath, [compiler, "--ignoreConfig", "--strict", "--target", "ES2024", "--module", "NodeNext",
      "--moduleResolution", "NodeNext", "--skipLibCheck", "--types", "node", "--typeRoots", resolve("node_modules/@types"), "--noEmit", fixture], { encoding: "utf8" });
  };
  const positive = compile('"logs_read"');
  assert.equal(positive.status, 0, positive.stdout + positive.stderr);
  const negative = compile("123");
  assert.equal(negative.status, 1, negative.stdout + negative.stderr);
  const diagnostics = [...negative.stdout.matchAll(/error (TS\d+):/g)].map((match) => match[1]);
  assert.deepEqual(diagnostics, ["TS2322"], negative.stdout + negative.stderr);
  console.log("Pi strict consumer: valid call accepted; invalid tools type rejected TS2322.");
} finally { rmSync(directory, { recursive: true, force: true }); }
