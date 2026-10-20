import { SqliteRecords } from "../../src/adapters/records/sqlite.js";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { existsSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const [directory, mode, ...requestedMarkers] = process.argv.slice(2);
if (!directory) throw new Error("invalid_request");
if (mode === "scan") {
  const markers = requestedMarkers.length ? requestedMarkers : ["SYNTHETIC-SECRET"];
  const found = ["records.sqlite", "records.sqlite-journal", "records.sqlite-wal", "records.sqlite-shm", "runtime-lock.sqlite", "runtime-lock.sqlite-journal"]
    .some((name) => existsSync(join(directory, name)) && markers.some((marker) => readFileSync(join(directory, name)).includes(Buffer.from(marker))));
  writeSync(1, found ? "sensitive-marker-found\n" : "clean\n");
  process.exit(found ? 1 : 0);
}
const mock = createMockTroubleshooting();
try {
  const store = new SqliteRecords(directory, mock.ports, { fault: (checkpoint) => {
    if (mode === "crash" && checkpoint === "admission:before_commit") {
      writeSync(1, "transaction-written\n");
      process.kill(process.pid, "SIGKILL");
    }
  } });
  if (mode === "crash") await store.admission.confirm({ key: "c".repeat(64), caseRef: "case-1", principalRef: mock.inbound.principalRef,
    initial: { context: { principalRef: "principal-1", tenantRef: "tenant-1", destinationRef: "private-conversation-1",
      caseRef: "case-1", phaseId: 1, resourceRefs: ["simulator-source"], policyVersion: "mock-policy-1",
      approvalRef: "mock-approval-1", snapshotRef: "simulator-snapshot-1", budgetRef: "case-1" },
    view: { caseRef: "case-1", phaseId: 1, state: "investigating", receivedAt: mock.inbound.receivedAt, acceptedAt: mock.inbound.receivedAt,
      phaseStartedAt: mock.inbound.receivedAt, deliveryStatus: "pending", usage: { modelAttempts: 0, logRecords: 0, logCoverageMs: 0 }, elapsedMs: 0,
      phases: [{ phaseId: 1, startedAt: mock.inbound.receivedAt }], inputWaits: [] }, input: { question: "Why?" } } });
  writeSync(1, "opened\n");
  if (mode === "hold") process.on("message", () => { store.close(); process.disconnect(); });
  else store.close();
} catch (error) {
  writeSync(1, `refused:${error instanceof Error ? error.message : "unavailable"}\n`);
}
