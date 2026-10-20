import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalTeamsHost } from "../../src/adapters/teams/host.js";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { teamsServices } from "../fixtures/teams.js";
import { postmanTeams } from "../fixtures/postman-teams.js";

test("actual signed Teams A/D host delivers status and validated report through the owned Postman Connector contract", { timeout: 20_000 }, async () => {
  assert.ok(process.env.POSTMAN_CLI, "Set POSTMAN_CLI to the reviewed local CLI1.74 executable.");
  const simulation = await postmanTeams(process.env.POSTMAN_CLI);
  const service = await teamsServices(); const mock = createMockTroubleshooting();
  const host = await createLocalTeamsHost({ ...service.configuration, serviceUrl: simulation.baseUrl }, { application: mock.application, ports: mock.ports });
  try {
    await host.start();
    const response = await fetch(host.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.serviceToken(false, { serviceurl: simulation.baseUrl })}` },
      body: JSON.stringify({ ...service.activity(), serviceUrl: simulation.baseUrl }) });
    assert.equal((await response.json() as { status: string }).status, "accepted");
    await mock.closed;
    const stored = await mock.ports.records.read(service.mapping.actor, "case-1"); assert.ok(stored?.scope === "full");
    assert.equal(stored.view.state, "completed"); assert.equal(stored.view.deliveryStatus, "delivered");
    await simulation.waitForRequests(2);
    const requests = simulation.requests(); assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.statusCode === 200));
    assert.equal(JSON.parse(String((requests[0]!.requestBody as { text: string }).text)).state, "accepted");
    assert.equal(JSON.parse(String((requests[1]!.requestBody as { text: string }).text)).simulator.shopCount, 10);
    assert.equal(JSON.stringify({ stored, logs: simulation.logs() }).includes("SYNTHETIC-SECRET"), false, "synthetic source canary must not escape");
    assert.equal(simulation.logs().stdout.includes("Bearer "), false, "protocol logs must not capture authorization tokens");
  } finally { await host.stop(); await service.close(); await simulation.close(); }
});
