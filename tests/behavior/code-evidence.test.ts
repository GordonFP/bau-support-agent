import test from "node:test";
import assert from "node:assert/strict";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";

test("the confirmed B snippet and trace operations return version-bound code evidence through the case", { timeout: 2000 }, async () => {
  const mock = createMockTroubleshooting({ agent: async (_context, request) => {
    await request.invoke("logs.read", null);
    await request.invoke("code.snippet", { repositoryRef: "simulator-source", symbol: "simulator.runSimulator", file: "simulator.ts" });
    await request.invoke("code.trace", { repositoryRef: "simulator-source", symbol: "simulator.runSimulator", file: "simulator.ts", direction: "outbound" });
    return request.generate(request.diagnose());
  } });
  await mock.receive();
  await mock.closed;
  const report = (await mock.delivery.next()).report;
  assert.equal(report.evidence.filter((item) => item.kind === "code").length, 2);
  assert.ok(report.evidence.filter((item) => item.kind === "code").every((item) => item.code?.snapshotRef === "simulator-snapshot-1"));
  assert.equal(mock.events.filter((event) => event.action === "code.snippet").length, 1);
  assert.equal(mock.events.filter((event) => event.action === "code.trace").length, 1);
});
