import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CallContext, Ports, TrustedActor } from "../../troubleshooting/application/ports.js";
import type { AuditDetails, CaseRecord, CaseRecords, DeliveryRecord, InitialCase, SavedContext, StoredCase, RecordDisclosure } from "../../troubleshooting/application/records.js";
import { auditRecord } from "../../troubleshooting/application/audit-record.js";
import { SqliteSession } from "./sqlite-session.js";
import { deniedContext, recordDenial } from "../../troubleshooting/application/authorization-audit.js";
import { advancesView, contextSnapshot, recordSnapshot, sameCaseAuthority, savedContextSnapshot } from "../../troubleshooting/application/record-contract.js";
import { MAX_ACTIVE_CASES } from "../../troubleshooting/application/limits.js";
import { recordAccessContext, recordActor, recordDisclosure, recordRole } from "../../troubleshooting/application/record-access.js";
import { modelBindingDigest } from "../../troubleshooting/application/model-budget.js";
import type { ControlledCopy } from "./controlled-copies.js";
import { sqliteRetention } from "./sqlite-retention.js";
import type { RetentionState } from "../../troubleshooting/application/retention-lifecycle.js";
import { isRetentionClosed, type Retention } from "../../troubleshooting/application/retention.js";
import { SqliteBudget } from "./sqlite-budget.js";

type Controls = Pick<Ports, "authorization" | "sanitization" | "clock">;

export class SqliteRecords {
  private readonly session: SqliteSession;
  readonly records: CaseRecords;
  readonly budget: SqliteBudget;
  readonly retention: Retention;

  constructor(directory: string, private readonly controls: Controls, private readonly options: { readonly fault?: (checkpoint: string) => void; readonly controlledCopies?: readonly ControlledCopy[] } = {}) {
    try { this.session = new SqliteSession(directory); } catch { throw new Error("unavailable"); }
    try {
      const db = this.session.database;
      const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
      const application = Number(db.prepare("PRAGMA application_id").get()!.application_id);
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => String(row.name));
      const fresh = version === 0 && application === 0 && tables.length === 0;
      if (!fresh && (![1, 2, 3].includes(version) || application !== 0x42415531 ||
        !["cases", "records", "audit", "case_sequence", "budget", "deliveries"].every((name) => tables.includes(name)) ||
        (version >= 2 && !tables.includes("budget_clock")) ||
        (version === 3 && !["retention", "event_tombstones"].every((name) => tables.includes(name))) ||
        !db.prepare("SELECT value FROM case_sequence WHERE id=1").get())) throw new Error("unavailable");
      if (version >= 2) {
        db.prepare("SELECT ended,started_at,estimated,binding FROM budget LIMIT 0");
        const rate = db.prepare("SELECT rate_ms FROM budget_clock WHERE id=1").get();
        if (!rate || !Number.isSafeInteger(rate.rate_ms) || Number(rate.rate_ms) < 0) throw new Error("unavailable");
      }
      if (version === 3 && !db.prepare("SELECT value FROM retention WHERE id=1").get()) throw new Error("unavailable");
      this.session.transaction(() => {
        this.session.database.exec(`
          CREATE TABLE IF NOT EXISTS cases(case_ref TEXT PRIMARY KEY, event_key TEXT UNIQUE NOT NULL, context TEXT NOT NULL, view TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS records(record_ref TEXT PRIMARY KEY, case_ref TEXT NOT NULL REFERENCES cases(case_ref), value TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY, receipt TEXT UNIQUE NOT NULL, call_id TEXT NOT NULL, action TEXT NOT NULL, stage TEXT NOT NULL, value TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS case_sequence(id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL) STRICT;
          INSERT INTO case_sequence VALUES(1,0) ON CONFLICT(id) DO NOTHING;
          CREATE TABLE IF NOT EXISTS budget(call_id TEXT PRIMARY KEY, case_ref TEXT NOT NULL, reserved INTEGER NOT NULL CHECK(reserved>=0),
            actual INTEGER CHECK(actual>=0), source TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS deliveries(delivery_key TEXT NOT NULL, segment INTEGER NOT NULL, case_ref TEXT NOT NULL, call_id TEXT NOT NULL, value TEXT NOT NULL,
            PRIMARY KEY(delivery_key,segment)) STRICT;
          CREATE TABLE IF NOT EXISTS budget_clock(id INTEGER PRIMARY KEY CHECK(id=1), rate_ms INTEGER NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS event_tombstones(event_key TEXT PRIMARY KEY, case_ref TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS retention(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL) STRICT;
          PRAGMA application_id=1111577905;
        `);
        if (fresh || version === 1) {
          this.session.database.exec(`ALTER TABLE budget ADD COLUMN ended INTEGER NOT NULL DEFAULT 0 CHECK(ended IN (0,1));
            ALTER TABLE budget ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE budget ADD COLUMN estimated INTEGER CHECK(estimated>=0);
            ALTER TABLE budget ADD COLUMN binding TEXT;
            UPDATE budget SET ended=1 WHERE actual IS NOT NULL;`);
          this.session.database.prepare("UPDATE budget SET started_at=0").run();
          for (const row of this.session.database.prepare("SELECT budget.call_id,cases.context FROM budget JOIN cases ON cases.case_ref=budget.case_ref").all()) {
            const saved = JSON.parse(String(row.context)) as SavedContext;
            const phase = /:phase-(\d+):/.exec(String(row.call_id));
            this.session.database.prepare("UPDATE budget SET binding=? WHERE call_id=?")
              .run(modelBindingDigest(JSON.stringify({ ...savedContextSnapshot({ ...saved, phaseId: phase ? Number(phase[1]) : saved.phaseId }), operationRef: String(row.call_id) })), String(row.call_id));
          }
          if (version === 1) this.options.fault?.("budget:migrate:before_commit");
        }
        this.session.database.prepare("INSERT INTO budget_clock VALUES(1,0) ON CONFLICT(id) DO NOTHING").run();
        if (version === 2) for (const row of this.session.database.prepare("SELECT call_id,binding FROM budget WHERE binding IS NOT NULL").all()) {
          this.session.database.prepare("UPDATE budget SET binding=? WHERE call_id=?").run(modelBindingDigest(String(row.binding)), String(row.call_id));
        }
        if (version < 3) this.session.database.prepare("INSERT INTO retention VALUES(1,?)").run(JSON.stringify({ scope: "poc", state: "untriggered", triggers: [], events: [] }));
        if (version < 3) this.options.fault?.("retention:migrate:before_commit");
        this.session.database.exec("PRAGMA user_version=3;");
        const retained = JSON.parse(String(this.session.database.prepare("SELECT value FROM retention WHERE id=1").get()!.value)) as RetentionState;
        const expired = isRetentionClosed(retained, Date.parse(controls.clock.utc()));
        if (expired && !retained.closedAt) this.session.database.prepare("UPDATE retention SET value=? WHERE id=1")
          .run(JSON.stringify({ ...retained, closedAt: controls.clock.utc() }));
        for (const row of this.session.database.prepare("SELECT case_ref, context, view FROM cases").all()) {
          const view = JSON.parse(String(row.view)) as InitialCase["view"];
          if (!expired && (view.state === "investigating" || view.state === "awaiting_input")) {
            const now = controls.clock.utc();
            const unknown = this.session.database.prepare("SELECT 1 AS present FROM deliveries WHERE case_ref=? AND json_extract(value,'$.status')='unknown'").get(String(row.case_ref));
            const interrupted = { ...view, state: "stopped", stopReason: "interrupted", ...(unknown ? { deliveryStatus: "unknown" } : {}), elapsedMs: Math.max(view.elapsedMs, Date.parse(now) - Date.parse(view.receivedAt)),
              phases: view.phases.map((phase) => phase.endedAt
              ? phase : { ...phase, endedAt: controls.clock.utc(), outcome: "stopped" }) };
            const saved = JSON.parse(String(row.context)) as SavedContext;
            const call: CallContext = { ...saved, phaseId: view.phaseId, callId: `${String(row.case_ref)}:restart:${randomUUID()}`,
              deadline: controls.clock.now(), signal: new AbortController().signal };
            this.auditInsert(call, "restart.interrupt", "intent", "pending");
            this.session.database.prepare("UPDATE cases SET view=? WHERE case_ref=?").run(JSON.stringify(interrupted), String(row.case_ref));
            const record: CaseRecord = { recordRef: `${call.callId}:view`, schemaVersion: 1, kind: "view", payload: interrupted };
            this.session.database.prepare("INSERT INTO records VALUES (?,?,?)").run(record.recordRef, String(row.case_ref), JSON.stringify(record));
            this.auditInsert(call, "restart.interrupt", "complete", "interrupted");
          }
        }
      });
    } catch { this.session.close(); throw new Error("unavailable"); }
    try {
      this.retention = sqliteRetention(this.session, this.session.directory, controls, this.options.fault, this.options.controlledCopies);
      this.budget = new SqliteBudget(this.session, controls, () => this.options.fault?.("budget:reserve:before_commit"), () => this.retention.closed());
      this.retention.onClose(async () => this.budget.close());
    } catch { this.session.close(); throw new Error("unavailable"); }
    this.records = { append: async (context, record) => {
      try { await this.append(context, record); }
      catch (error) { throw new Error(error instanceof Error && ["denied", "invalid_request", "unsafe_content"].includes(error.message) ? error.message : "unavailable"); }
    }, read: (actor, ref) => this.access(actor, ref, "records.read"), export: (actor, ref) => this.access(actor, ref, "records.export") };
  }

  readonly admission = {
    lookup: async (key: string): Promise<{ caseRef: string; principalRef: string } | null> => {
      if (this.retention.closed()) return null;
      const row = this.session.database.prepare("SELECT case_ref, context FROM cases WHERE event_key=?").get(key);
      return row ? { caseRef: String(row.case_ref), principalRef: (JSON.parse(String(row.context)) as SavedContext).principalRef } : null;
    },
    allocateCaseRef: (): string => {
      if (this.retention.closed()) throw new Error("denied");
      return this.session.transaction(() => {
      this.session.database.prepare("UPDATE case_sequence SET value=value+1 WHERE id=1").run();
      return `case-${Number(this.session.database.prepare("SELECT value FROM case_sequence WHERE id=1").get()!.value)}`;
      });
    },
    confirm: async (record: { key: string; caseRef: string; principalRef: string; initial: InitialCase }): Promise<
      { status: "confirmed" } | { status: "duplicate"; caseRef: string; principalRef: string; view: InitialCase["view"] } | { status: "full" }> => {
      if (this.retention.closed()) throw new Error("denied");
      this.safe(record.initial);
      return this.session.transaction(() => {
        const existing = this.session.database.prepare("SELECT case_ref, context, view FROM cases WHERE event_key=?").get(record.key);
        if (existing) {
          const context = JSON.parse(String(existing.context)) as SavedContext;
          return { status: "duplicate", caseRef: String(existing.case_ref), principalRef: context.principalRef,
            view: JSON.parse(String(existing.view)) as InitialCase["view"] };
        }
        const active = this.session.database.prepare("SELECT COUNT(*) AS n FROM cases WHERE json_extract(view,'$.state') IN ('investigating','awaiting_input')").get();
        if (Number(active?.n) >= MAX_ACTIVE_CASES) return { status: "full" };
        const context = savedContextSnapshot(record.initial.context);
        this.session.database.prepare("INSERT INTO cases VALUES (?,?,?,?)").run(record.caseRef, record.key, JSON.stringify(context), JSON.stringify(record.initial.view));
        const input: CaseRecord = { recordRef: `${record.caseRef}:input`, schemaVersion: 1, kind: "input", payload: record.initial.input };
        this.session.database.prepare("INSERT INTO records VALUES (?,?,?)").run(input.recordRef, record.caseRef, JSON.stringify(input));
        this.options.fault?.("admission:before_commit");
        return { status: "confirmed" };
      });
    },
    release: async (_caseRef: string): Promise<void> => {},
  };

  readonly audit: Ports["audit"] = {
    intent: async (context, action, details) => this.auditWrite(context, action, "intent", "pending", details),
    complete: async (context, action, outcome, details) => { this.auditWrite(context, action, "complete", outcome, details); },
  };

  private safe(value: unknown): void {
    if (!this.controls.sanitization.safe(value) || Buffer.byteLength(JSON.stringify(value)) > 1_048_576) throw new Error("unsafe_content");
  }

  private auditWrite(context: CallContext, action: string, stage: string, outcome: string, details?: AuditDetails): string {
    if (this.retention.closed()) { this.retention.recordDeniedAccess(context, action); throw new Error("denied"); }
    return this.session.transaction(() => {
      const receipt = this.auditInsert(context, action, stage, outcome, details);
      this.options.fault?.(`audit:${action}:${stage}`);
      return receipt;
    });
  }

  private auditInsert(context: CallContext, action: string, stage: string, outcome: string, details?: AuditDetails): string {
    const receipt = `audit-${randomUUID()}`;
    const cost = action === "model.generate" ? this.session.database.prepare("SELECT reserved,actual,source FROM budget WHERE call_id=?").get(context.callId) : undefined;
    const value = auditRecord(context, action, stage, outcome, this.controls.clock.utc(), details,
      cost ? { source: String(cost.source), reserved: Number(cost.reserved), actual: cost.actual === null ? null : Number(cost.actual) } : undefined);
    this.safe(value);
    if (stage === "intent") {
      const previous = this.session.database.prepare("SELECT receipt,value FROM audit WHERE call_id=? AND action=? AND stage='intent'").get(context.callId, action);
      if (previous) {
        const binding = ({ occurredAt: _time, settlement: _cost, ...stable }: Readonly<Record<string, unknown>>) => stable;
        if (!isDeepStrictEqual(binding(JSON.parse(String(previous.value)) as Record<string, unknown>), binding(value))) throw new Error("invalid_request");
        return String(previous.receipt);
      }
    }
    if (action === "delivery.send" && details?.delivery) {
      const delivery = details.delivery;
      if (!Number.isSafeInteger(delivery.segment) || delivery.segment < 1 || !delivery.deliveryKey.startsWith(`${context.caseRef}:`)) throw new Error("invalid_request");
      const previous = this.session.database.prepare("SELECT call_id FROM deliveries WHERE delivery_key=? AND segment=?").get(delivery.deliveryKey, delivery.segment);
      if (previous && String(previous.call_id) !== context.callId) throw new Error("invalid_request");
      const record: DeliveryRecord = { schemaVersion: 1, caseRef: context.caseRef, callId: context.callId,
        deliveryKey: delivery.deliveryKey, segment: delivery.segment, status: stage === "complete" && outcome === "ok" ? delivery.status ?? "unknown" : "unknown" };
      this.session.database.prepare("INSERT INTO deliveries VALUES(?,?,?,?,?) ON CONFLICT(delivery_key,segment) DO UPDATE SET value=excluded.value")
        .run(delivery.deliveryKey, delivery.segment, context.caseRef, context.callId, JSON.stringify(record));
    }
    this.session.database.prepare("INSERT INTO audit(receipt,call_id,action,stage,value) VALUES (?,?,?,?,?)")
      .run(receipt, context.callId, action, stage, JSON.stringify(value));
    return receipt;
  }

  private async append(context: CallContext, record: CaseRecord): Promise<void> {
    context = contextSnapshot(context);
    record = recordSnapshot(context, record);
    if (this.retention.closed()) throw new Error("denied");
    const row = this.session.database.prepare("SELECT context FROM cases WHERE case_ref=?").get(context.caseRef);
    const saved = row ? JSON.parse(String(row.context)) as SavedContext : undefined;
    if (!saved || !sameCaseAuthority(context, saved) ||
      !await this.controls.authorization.allows("records.append", context)) {
      await recordDenial(this.audit, deniedContext(context, context.caseRef, this.controls));
      throw new Error("denied");
    }
    this.safe(record);
    if (this.retention.closed()) throw new Error("denied");
    this.session.transaction(() => {
      const existing = this.session.database.prepare("SELECT case_ref,value FROM records WHERE record_ref=?").get(record.recordRef);
      if (existing) {
        if (String(existing.case_ref) !== context.caseRef || String(existing.value) !== JSON.stringify(record)) throw new Error("invalid_request");
        return;
      }
      this.session.database.prepare("INSERT INTO records VALUES (?,?,?)").run(record.recordRef, context.caseRef, JSON.stringify(record));
      if (record.kind === "view") {
        const current = JSON.parse(String(this.session.database.prepare("SELECT view FROM cases WHERE case_ref=?").get(context.caseRef)!.view)) as InitialCase["view"];
        if (advancesView(current, record.payload as InitialCase["view"])) this.session.database.prepare("UPDATE cases SET view=? WHERE case_ref=?").run(JSON.stringify(record.payload), context.caseRef);
      }
    });
  }

  private async read(actor: TrustedActor, caseRef: string, action: string): Promise<RecordDisclosure | null> {
    actor = recordActor(actor);
    if (this.retention.closed()) { this.retention.recordDeniedAccess(actor, action); return null; }
    const row = this.session.database.prepare("SELECT context, view FROM cases WHERE case_ref=?").get(caseRef);
    if (!row) { await recordDenial(this.audit, deniedContext(actor, caseRef, this.controls)); return null; }
    const saved = JSON.parse(String(row.context)) as SavedContext;
    const role = await recordRole(this.controls.authorization, actor, saved, action);
    if (!role) {
      await recordDenial(this.audit, deniedContext(actor, caseRef, this.controls));
      return null;
    }
    const context = recordAccessContext(actor, saved, role, `${caseRef}:${action}:${randomUUID()}`, this.controls.clock.now());
    await this.audit.intent(context, action);
    const records = this.session.database.prepare("SELECT value FROM records WHERE case_ref=? ORDER BY rowid").all(caseRef)
      .map((entry) => JSON.parse(String(entry.value)) as CaseRecord);
    const audits = this.session.database.prepare("SELECT value FROM audit WHERE json_extract(value,'$.caseRef')=? ORDER BY sequence").all(caseRef)
      .map((entry) => JSON.parse(String(entry.value)) as Readonly<Record<string, unknown>>);
    const deliveries = this.session.database.prepare("SELECT value FROM deliveries WHERE case_ref=? ORDER BY delivery_key,segment").all(caseRef)
      .map((entry) => JSON.parse(String(entry.value)) as DeliveryRecord);
    await this.audit.complete(context, action, "allowed");
    const currentRole = await recordRole(this.controls.authorization, actor, saved, action);
    if (this.retention.closed()) { this.retention.recordDeniedAccess(actor, action); return null; }
    if (currentRole !== role) {
      await recordDenial(this.audit, deniedContext(actor, caseRef, this.controls));
      return null;
    }
    const result: StoredCase = { scope: "full", view: JSON.parse(String(row.view)) as InitialCase["view"], records, audits, deliveries };
    this.safe(result);
    return recordDisclosure(result, role);
  }

  private async access(actor: TrustedActor, caseRef: string, action: string): Promise<RecordDisclosure | null> {
    try { return await this.read(actor, caseRef, action); } catch { throw new Error("unavailable"); }
  }

  close(): void { this.budget.close(); this.session.close(); }
}
