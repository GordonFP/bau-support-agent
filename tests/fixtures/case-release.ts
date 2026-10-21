import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { createLocalTeamsHost } from "../../src/adapters/teams/host.js";
import { teamsServices } from "./teams.js";
const signals: WeakRef<AbortSignal>[] = [];
let elapsed = 0;
const paused = process.argv[2]?.startsWith("paused") === true;
const mock = createMockTroubleshooting({ ...(paused ? { customerCandidates: [
  { applicationId: "SYNTHETIC-SECRET-APPLICATION", submittedAt: "2026-10-18T10:00:00.000Z" },
  { applicationId: "SYNTHETIC-SECRET-APPLICATION-SECOND", submittedAt: "2026-10-18T15:00:00.000Z" },
] } : {}), clock: { now: () => elapsed, utc: () => new Date(Date.parse("2026-10-19T09:00:00.000Z") + elapsed).toISOString() }, agent: async (context, request) => {
  signals.push(new WeakRef(context.signal)); await request.invoke("logs.read", null); await request.invoke("code.search", null); return request.generate(request.diagnose());
} });
const services = process.argv[2]?.endsWith("teams") ? await teamsServices() : undefined;
const host = services ? await createLocalTeamsHost(services.configuration, { application: mock.application, ports: mock.ports }) : undefined;
if (host) await host.start();
for (let index = 0; index < 40; index++) {
  const accepted = await mock.receive({ eventRef: `release-${index}`, ...(paused ? { input: { customerId: "SYNTHETIC-SECRET-CUSTOMER", question: "Why?" } } : {}) });
  if (!("view" in accepted)) throw new Error("acceptance_failed");
  await mock.phaseClosed(1, accepted.view.caseRef); await new Promise(setImmediate);
  if (paused) {
    for (let turn = 0; turn < 6; turn++) await new Promise(setImmediate);
    const cancelled = await mock.application.cancel(mock.inbound, accepted.view.caseRef);
    if (!("state" in cancelled) || cancelled.state !== "stopped") throw new Error("paused_cancel_failed");
    for (let turn = 0; turn < 6; turn++) await new Promise(setImmediate);
  }
  elapsed += 61_000;
}
for (let index = 0; index < 6; index++) { await new Promise(setImmediate); global.gc!(); }
await new Promise(setImmediate);
const retained = signals.filter((signal) => signal.deref()).length;
const view = await mock.application.get(mock.inbound, "case-1");
const cancel = await mock.application.cancel(mock.inbound, "case-1");
const reply = await mock.application.provideInformation({ ...mock.inbound, eventRef: "terminal-reply", reply: { caseRef: "case-1", questionId: "unused" }, content: {} });
const duplicate = await mock.receive({ eventRef: "release-0" });
process.stdout.write(JSON.stringify({ retained, view, cancel, reply, duplicate, physicalMessages: services?.writes.length, closures: mock.events.filter((item) => item.action === "agent.close").length, investigations: mock.events.filter((item) => item.action === "model.generate").length }));
await host?.stop();
await mock.application.close();
await services?.close();
