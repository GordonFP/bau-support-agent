import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";

let elapsed = 0;
const timers = new Set<{ deadline: number; callback: () => void }>();
const clock = { now: () => elapsed, utc: () => new Date(Date.parse("2026-10-19T09:00:00Z") + elapsed).toISOString(),
  schedule(deadline: number, callback: () => void) { const timer = { deadline, callback }; timers.add(timer); return () => { timers.delete(timer); }; },
  advance(milliseconds: number) { elapsed += milliseconds; for (const timer of [...timers]) if (timer.deadline <= elapsed) { timers.delete(timer); timer.callback(); } } };
const tick = () => new Promise(setImmediate);
const signals: WeakRef<AbortSignal>[] = [];
const mock = createMockTroubleshooting({ clock });
const confirm = mock.ports.admission.confirm;
const complete = mock.ports.audit.complete;
const allows = mock.ports.authorization.allows;
mock.ports.authorization.allows = async (action, context) => { if (action === "accept" && "signal" in context && context.signal instanceof AbortSignal) signals.push(new WeakRef(context.signal)); return allows(action, context); };
let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let entered: ReturnType<typeof Promise.withResolvers<void>> | undefined;
if (process.argv[2] === "accepted-audit") {
  mock.ports.audit.complete = async (context, action, outcome, details) => {
    if (action === "accept") { entered!.resolve(); await gate!.promise; }
    return complete(context, action, outcome, details);
  };
} else {
  mock.ports.admission.confirm = async (record) => { entered!.resolve(); await gate!.promise; return confirm(record); };
}
for (let index = 0; index < 40; index++) {
  gate = Promise.withResolvers<void>(); entered = Promise.withResolvers<void>();
  const accepting = mock.receive({ eventRef: `late-confirm-${index}` });
  await entered.promise; clock.advance(180_000);
  const result = await accepting;
  if (result.status !== "service_unavailable" || result.reason !== "timeout") throw new Error("unexpected_local_result");
  gate.resolve(); for (let turn = 0; turn < 6; turn++) await tick();
}
gate = undefined; entered = undefined;
for (let turn = 0; turn < 6; turn++) { await tick(); global.gc!(); }
await tick();
const retained = signals.filter((signal) => signal.deref()).length;
const view = await mock.application.get(mock.inbound, "case-40");
const duplicate = await mock.receive({ eventRef: "late-confirm-39" });
process.stdout.write(JSON.stringify({ retained, view, duplicate, investigations: mock.events.filter((event) => event.action === "logs.read").length,
  closes: mock.events.filter((event) => event.action === "agent.close").length }));
await mock.application.close();
