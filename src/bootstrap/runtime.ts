import { isAbsolute } from "node:path";
import { z } from "zod/v4";
import { createMockTroubleshooting, type MockOptions } from "../adapters/mock/troubleshooting.js";
import { SqliteRecords } from "../adapters/records/sqlite.js";
import { beforeDeadline } from "../troubleshooting/application/deadline.js";
import { CLEANUP_MS } from "../troubleshooting/application/limits.js";
import { syntheticPsp } from "./synthetic.js";
import { runtimeGates } from "./gates.js";
import { randomUUID } from "node:crypto";
import type { CallContext } from "../troubleshooting/application/ports.js";

const configuration = z.strictObject({ schemaVersion: z.literal(1), profile: z.literal("mock"),
  recordsDirectory: z.string().min(1).max(1024).refine((value) => isAbsolute(value) && !value.includes("\0")) });
export interface RuntimeTestPorts {
  readonly mocks?: Pick<MockOptions, "clock" | "agent" | "model">;
  readonly storeFault?: (checkpoint: string) => void;
}

// Technical host composition. Configuration never selects a module, endpoint,
// credential, native option or real route. Tests exercise the existing A–D ports.
export async function openMockRuntime(input: unknown, controls: RuntimeTestPorts = {}) {
  let store: SqliteRecords | undefined;
  try {
    const config = configuration.parse(input);
    const gates = await runtimeGates();
    const mock = createMockTroubleshooting({ pspObservation: syntheticPsp, clock: { now: () => performance.now(), utc: () => new Date().toISOString() }, ...controls.mocks,
      controlPorts: (ports) => {
        store = new SqliteRecords(config.recordsDirectory, ports, controls.storeFault ? { fault: controls.storeFault } : {});
        return { admission: store.admission, records: store.records, deliveryLedger: store.deliveryLedger, audit: store.audit, budget: store.budget, retention: store.retention };
      } });
    const records = store!;
    const context: CallContext = { ...mock.inbound, caseRef: "bootstrap", phaseId: 1, callId: `bootstrap:${randomUUID()}`,
      resourceRefs: ["simulator-source", "psp-log-source", "psp-code"], policyVersion: "mock-policy-1", approvalRef: "mock-approval-1",
      snapshotRef: "simulator-snapshot-1", budgetRef: "bootstrap", deadline: mock.ports.clock.now() + CLEANUP_MS, signal: new AbortController().signal };
    await records.audit.intent(context, "runtime.start"); await records.audit.complete(context, "runtime.start", "mock_ready");
    let closing: Promise<void> | undefined;
    let closeDeadline = 0;
    let closed = false;
    const close = async (): Promise<"closed" | "unknown"> => {
      if (!closing) {
        closeDeadline = mock.ports.clock.now() + CLEANUP_MS;
        closing = (async () => { await mock.application.close(); records.close(); closed = true; })();
        void closing.catch(() => {});
      }
      if (closed) return "closed";
      try { await beforeDeadline(mock.ports.clock, closeDeadline, () => closing!); return "closed"; }
      catch { return "unknown"; }
    };
    return { ...mock, gates, close };
  } catch { store?.close(); throw new Error("runtime_unavailable"); }
}
