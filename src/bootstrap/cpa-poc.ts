import { resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { createMockTroubleshooting } from "../adapters/mock/troubleshooting.js";
import { createResponsesGateway, cpaPocModelPolicy } from "../adapters/model/responses.js";
import { createPiRuntime } from "../adapters/pi/runtime.js";
import { SqliteRecords } from "../adapters/records/sqlite.js";
import { beforeDeadline } from "../troubleshooting/application/deadline.js";
import { CASE_EXECUTION_MS, CLEANUP_MS } from "../troubleshooting/application/limits.js";
import { syntheticPsp } from "./synthetic.js";
import { runtimeGates } from "./gates.js";
import type { CallContext } from "../troubleshooting/application/ports.js";

/** Developer-only G2 harness. The caller cannot supply questions, data, identities or resources. */
export async function openCpaPoc(options: { readonly baseUrl: string; readonly apiKey: string; readonly recordsDirectory: string }) {
  if (!isAbsolute(options.recordsDirectory)) throw new Error("invalid_request");
  await runtimeGates();
  const clock = { now: () => performance.now(), utc: () => new Date().toISOString() };
  const gateway = createResponsesGateway({ route: "cpa", contract: cpaPocModelPolicy.protocol, baseUrl: options.baseUrl, apiKey: options.apiKey, clock });
  const pi = await createPiRuntime({ skillPath: resolve("runtime-skills/bau-troubleshooting/SKILL.md"), clock, modelPolicy: cpaPocModelPolicy });
  let store: SqliteRecords | undefined;
  const mock = createMockTroubleshooting({ pspObservation: syntheticPsp, clock, modelProfile: "cpa_poc", modelPolicy: cpaPocModelPolicy,
    controlPorts: (ports) => {
      store = new SqliteRecords(options.recordsDirectory, ports);
      return { admission: store.admission, records: store.records, deliveryLedger: store.deliveryLedger, audit: store.audit, budget: store.budget, retention: store.retention };
    } });
  if (!store) throw new Error("runtime_unavailable");
  const records = store;
  const startup: CallContext = { ...mock.inbound, caseRef: "bootstrap", phaseId: 1, callId: `bootstrap:${randomUUID()}`, resourceRefs: ["simulator-source", "psp-log-source", "psp-code"],
    policyVersion: "cpa-poc-output-observation-1", approvalRef: "synthetic-poc-2026-10-22", snapshotRef: "simulator-snapshot-1", budgetRef: "bootstrap",
    deadline: clock.now() + CLEANUP_MS, signal: new AbortController().signal };
  try { await records.audit.intent(startup, "runtime.start"); await records.audit.complete(startup, "runtime.start", "cpa_synthetic_poc_ready"); }
  catch { records.close(); throw new Error("runtime_unavailable"); }
  const notifyClosed = mock.ports.agent.close;
  mock.ports.agent.run = pi.run; mock.ports.agent.abort = pi.abort;
  mock.ports.agent.close = async (caseRef, phaseId) => { await pi.close(caseRef, phaseId); await notifyClosed(caseRef, phaseId); };
  mock.ports.model.generate = gateway.generate;
  let closing: Promise<void> | undefined;
  let deadline = 0;
  let closed = false;
  const close = async (): Promise<"closed" | "unknown"> => {
    if (!closing) {
      deadline = clock.now() + CLEANUP_MS;
      closing = (async () => { await mock.application.close(); records.close(); closed = true; })();
      void closing.catch(() => {});
    }
    if (closed) return "closed";
    try { await beforeDeadline(clock, deadline, () => closing!); return "closed"; } catch { return "unknown"; }
  };
  return {
    async run(scene: "simulator" | "psp") {
      if (closing || !["simulator", "psp"].includes(scene)) throw new Error("invalid_request");
      const accepted = await mock.receive({ eventRef: `cpa-poc:${randomUUID()}`, receivedAt: clock.utc(), input: scene === "psp"
        ? { scenario: "psp", applicationId: "SYNTHETIC-SECRET-APPLICATION", shopId: "SYNTHETIC-SECRET-SHOP", bindingId: "SYNTHETIC-SECRET-BINDING", question: "Explain this synthetic PSP verification." }
        : { applicationId: "SYNTHETIC-SECRET-APPLICATION", question: "Explain this synthetic Simulator readiness." } });
      if (accepted.status !== "accepted") throw new Error("unavailable");
      await beforeDeadline(clock, clock.now() + CASE_EXECUTION_MS + CLEANUP_MS, () => mock.phaseClosed(1, accepted.view.caseRef));
      const saved = await records.records.export(mock.inbound, accepted.view.caseRef);
      if (saved?.scope !== "full") throw new Error("unavailable");
      return { scene, saved, budget: await records.budget.status(accepted.view.caseRef) };
    },
    close,
  };
}
