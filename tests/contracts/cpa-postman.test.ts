import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCpaPoc } from "../../src/bootstrap/cpa-poc.js";
import { postmanSimulation } from "../fixtures/postman-simulation.js";

test("actual Pi and A–D complete two fixed synthetic CPA cases with durable unknown fees and token observations", { timeout: 30_000 }, async () => {
  assert.ok(process.env.POSTMAN_CLI);
  const simulation = await postmanSimulation(process.env.POSTMAN_CLI, "postman/simulations/cpa-poc.sim.yaml", "/cpa/v1");
  const directory = await mkdtemp(join(tmpdir(), "bau-cpa-contract-"));
  let runtime: Awaited<ReturnType<typeof openCpaPoc>> | undefined;
  try {
    runtime = await openCpaPoc({ baseUrl: simulation.baseUrl, apiKey: "synthetic-client-key", recordsDirectory: directory });
    for (const scene of ["simulator", "psp"] as const) {
      const result = await runtime.run(scene);
      assert.equal(result.saved.view.state, "completed");
      assert.ok(result.saved.records.some((record) => record.kind === "report"));
      assert.ok(result.saved.deliveries.some((delivery) => delivery.status === "delivered"));
      assert.equal(result.budget.attempts, 3); assert.equal(result.budget.reservedMicrousd, 540_000);
      assert.equal(result.budget.unsettledCalls, 0);
      assert.ok(result.budget.charges.every((charge) => charge.source === "estimated" && charge.estimatedMicrousd !== null && charge.actualMicrousd === null));
      assert.ok(result.saved.records.filter((record) => record.kind === "model_output").every((record) =>
        (record.payload as { tokenUsage: { source: string } }).tokenUsage.source === "upstream_tokens"));
      assert.doesNotMatch(JSON.stringify(result.saved), /SYNTHETIC-SECRET|synthetic-client-key/);
    }
    await simulation.waitForRequests(6);
    assert.ok(simulation.requests().every((request) => {
      const body = request.requestBody as { model: string; max_output_tokens?: number };
      return body.model === "gpt-6.1-sol" && body.max_output_tokens === undefined;
    }));
    assert.equal(await runtime.close(), "closed");
  } finally { await runtime?.close(); await simulation.close(); await rm(directory, { recursive: true, force: true }); }
});
