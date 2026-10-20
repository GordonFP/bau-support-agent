import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import type { CallContext } from "../../src/troubleshooting/application/ports.js";

// Closed synthetic schema-1 storage from #18; only fixture setup uses SQL.
export function legacyRecords(directory: string, context: CallContext): void {
  const path = join(directory, "records.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE cases(case_ref TEXT PRIMARY KEY,event_key TEXT UNIQUE NOT NULL,context TEXT NOT NULL,view TEXT NOT NULL) STRICT;
      CREATE TABLE records(record_ref TEXT PRIMARY KEY,case_ref TEXT NOT NULL REFERENCES cases(case_ref),value TEXT NOT NULL) STRICT;
      CREATE TABLE audit(sequence INTEGER PRIMARY KEY,receipt TEXT UNIQUE NOT NULL,call_id TEXT NOT NULL,action TEXT NOT NULL,stage TEXT NOT NULL,value TEXT NOT NULL) STRICT;
      CREATE TABLE case_sequence(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL) STRICT;
      INSERT INTO case_sequence VALUES(1,1);
      CREATE TABLE budget(call_id TEXT PRIMARY KEY,case_ref TEXT NOT NULL,reserved INTEGER NOT NULL CHECK(reserved>=0),actual INTEGER CHECK(actual>=0),source TEXT NOT NULL) STRICT;
      CREATE TABLE deliveries(delivery_key TEXT NOT NULL,segment INTEGER NOT NULL,case_ref TEXT NOT NULL,call_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(delivery_key,segment)) STRICT;
      PRAGMA application_id=1111577905; PRAGMA user_version=1;`);
    const { signal: _signal, deadline: _deadline, callId: _callId, ...saved } = context;
    db.prepare("INSERT INTO cases VALUES(?,?,?,?)").run("case-1", "a".repeat(64), JSON.stringify(saved), JSON.stringify({ state: "stopped" }));
    db.prepare("INSERT INTO budget VALUES(?,?,?,?,'mock_usage')").run("case-1:phase-1:known", "case-1", 180_000, 4_000);
    db.prepare("INSERT INTO budget VALUES(?,?,?,NULL,'unknown')").run("case-1:phase-1:unknown", "case-1", 180_000);
    db.prepare("INSERT INTO budget VALUES(?,?,?,NULL,'unknown')").run("orphan:phase-1:unknown", "orphan", 180_000);
  } finally { db.close(); chmodSync(path, 0o600); }
}

// Closed #19 schema-2 sample with the former full canonical binding, for migration only.
export function legacyBudget2(directory: string, context: CallContext): void {
  legacyRecords(directory, context);
  const db = new DatabaseSync(join(directory, "records.sqlite"));
  try {
    db.exec(`ALTER TABLE budget ADD COLUMN ended INTEGER NOT NULL DEFAULT 0 CHECK(ended IN(0,1));
      ALTER TABLE budget ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE budget ADD COLUMN estimated INTEGER CHECK(estimated>=0);
      ALTER TABLE budget ADD COLUMN binding TEXT;
      UPDATE budget SET ended=1 WHERE actual IS NOT NULL;
      CREATE TABLE budget_clock(id INTEGER PRIMARY KEY CHECK(id=1),rate_ms INTEGER NOT NULL) STRICT;
      INSERT INTO budget_clock VALUES(1,0); PRAGMA user_version=2;`);
    for (const operation of ["known", "unknown"]) {
      const callId = `case-1:phase-1:${operation}`;
      const binding = { caseRef: context.caseRef, phaseId: context.phaseId, principalRef: context.principalRef, tenantRef: context.tenantRef,
        destinationRef: context.destinationRef, policyVersion: context.policyVersion, approvalRef: context.approvalRef, resourceRefs: context.resourceRefs,
        snapshotRef: context.snapshotRef, budgetRef: context.budgetRef, operationRef: callId };
      db.prepare("UPDATE budget SET binding=? WHERE call_id=?").run(JSON.stringify(binding), callId);
    }
  } finally { db.close(); }
}
