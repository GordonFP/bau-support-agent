// Only fixed synthetic cases are accepted. CPA owns the user's OAuth credential;
// a pinned independent process gets an ephemeral client key and no business tools.
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { openCpaPoc } from "../dist/src/bootstrap/cpa-poc.js";
import { startCpaPocService } from "./cpa-poc-service.mjs";

const directory = process.argv[2];
if (!directory) {
  console.error("Usage: node scripts/run-cpa-poc.mjs <owned records directory>");
  process.exitCode = 1;
} else {
  let runtime;
  let cpa;
  let stopping = false;
  const stop = () => { stopping = true; process.exitCode = 130; if (runtime) void runtime.close().then(() => cpa?.close()).catch(() => {}); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const root = resolve(directory);
    await mkdir(root, { mode: 0o700, recursive: true });
    cpa = await startCpaPocService();
    if (stopping) throw new Error("cancelled");
    runtime = await openCpaPoc({ baseUrl: cpa.baseUrl, apiKey: cpa.apiKey, recordsDirectory: root });
    for (const scene of ["simulator", "psp"]) {
      if (stopping) break;
      const result = await runtime.run(scene);
      await writeFile(resolve(root, `${scene}.json`), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
      const outputs = result.saved.records.filter((record) => record.kind === "model_output");
      console.log(JSON.stringify({ scene, state: result.saved.view.state, stopReason: result.saved.view.stopReason ?? null,
        attempts: result.budget.attempts, reservedMicrousd: result.budget.reservedMicrousd, actualCost: "unknown",
        tokenUsage: outputs.map((record) => record.payload.tokenUsage ?? null) }));
      if (result.saved.view.state !== "completed") { process.exitCode = 1; break; }
    }
  } catch { console.error(stopping ? "cpa_poc_cancelled" : "cpa_poc_unavailable"); process.exitCode ??= 1; }
  finally {
    if (runtime) { const closed = await runtime.close(); console.log(JSON.stringify({ hostClose: closed })); if (closed !== "closed") process.exitCode = 1; }
    await cpa?.close();
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
  }
}
