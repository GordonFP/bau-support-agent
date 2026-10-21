import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { createLocalTeamsHost } from "../../src/adapters/teams/host.js";
import { teamsServices } from "./teams.js";
const signals: WeakRef<AbortSignal>[] = [];
let elapsed = 0;
const mock = createMockTroubleshooting({ clock: { now: () => elapsed, utc: () => new Date(Date.parse("2026-10-19T09:00:00.000Z") + elapsed).toISOString() }, agent: async (context, request) => {
  signals.push(new WeakRef(context.signal)); await request.invoke("logs.read", null); await request.invoke("code.search", null); return request.generate(request.diagnose());
} });
const services = process.argv[2] === "teams" ? await teamsServices() : undefined;
const host = services ? await createLocalTeamsHost(services.configuration, { application: mock.application, ports: mock.ports }) : undefined;
if (host) await host.start();
for (let index = 0; index < 40; index++) {
  const accepted = await mock.receive({ eventRef: `release-${index}` });
  if (!("view" in accepted)) throw new Error("acceptance_failed");
  await mock.phaseClosed(1, accepted.view.caseRef); await new Promise(setImmediate); elapsed += 61_000;
}
for (let index = 0; index < 6; index++) { await new Promise(setImmediate); global.gc!(); }
await new Promise(setImmediate);
const retained = signals.filter((signal) => signal.deref()).length;
const view = await mock.application.get(mock.inbound, "case-1");
const cancel = await mock.application.cancel(mock.inbound, "case-1");
const reply = await mock.application.provideInformation({ ...mock.inbound, eventRef: "terminal-reply", reply: { caseRef: "case-1", questionId: "unused" }, content: {} });
const duplicate = await mock.receive({ eventRef: "release-0" });
process.stdout.write(JSON.stringify({ retained, view, cancel, reply, duplicate, physicalMessages: services?.writes.length, investigations: mock.events.filter((item) => item.action === "model.generate").length }));
await host?.stop();
await mock.application.close();
await services?.close();
