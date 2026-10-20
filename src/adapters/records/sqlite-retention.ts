import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Ports } from "../../troubleshooting/application/ports.js";
import { RetentionLifecycle, type RetentionState } from "../../troubleshooting/application/retention-lifecycle.js";
import { ControlledCopies, type ControlledCopy } from "./controlled-copies.js";
import type { DeletionCheck } from "../../troubleshooting/application/retention.js";
import type { SqliteSession } from "./sqlite-session.js";

export function sqliteRetention(session: SqliteSession, directory: string, controls: Pick<Ports, "clock" | "authorization">, fault?: (point: string) => void, configuredCopies?: readonly ControlledCopy[]): RetentionLifecycle {
  const copies = new ControlledCopies(directory, configuredCopies);
  return new RetentionLifecycle(controls, {
    load: () => {
      const row = session.database.prepare("SELECT value FROM retention WHERE id=1").get();
      if (!row) throw new Error("unavailable");
      const value = JSON.parse(String(row.value)) as RetentionState;
      if (value.scope !== "poc" || !["untriggered", "scheduled", "deleting", "partial", "deleted"].includes(value.state) ||
        !Array.isArray(value.triggers) || !Array.isArray(value.events)) throw new Error("unavailable");
      return value;
    },
    purge: async () => {
      const checks: DeletionCheck[] = [];
      try {
        session.transaction(() => {
          session.database.exec(`INSERT INTO event_tombstones SELECT event_key,case_ref FROM cases WHERE 1 ON CONFLICT(event_key) DO NOTHING;
            DELETE FROM records; DELETE FROM audit; DELETE FROM cases;`);
          fault?.("retention:delete:before_commit");
        });
        checks.push({ scope: "sqlite_rows", result: "deleted", verification: "full record/audit/case rows deleted; minimal event digests retained" });
      } catch { return [{ scope: "sqlite_rows", result: "failed", verification: "row deletion transaction not committed; retry required" }]; }
      checks.push(...copies.purge(fault));
      try {
        fault?.("retention:vacuum:before");
        session.database.exec("VACUUM");
        const freePages = Number(session.database.prepare("PRAGMA freelist_count").get()!.freelist_count);
        const mode = session.database.prepare("PRAGMA journal_mode").get()!.journal_mode;
        const secure = session.database.prepare("PRAGMA secure_delete").get()!.secure_delete;
        const temporary = session.database.prepare("PRAGMA temp_store").get()!.temp_store;
        copies.validate();
        if (freePages !== 0 || mode !== "delete" || secure !== 1 || temporary !== 2 ||
          ["-journal", "-wal", "-shm"].some((suffix) => existsSync(join(directory, `records.sqlite${suffix}`))) ||
          readdirSync(directory).some((name) => !["records.sqlite", "runtime-lock.sqlite", "runtime-lock.sqlite-journal", "controlled-copies"].includes(name))) throw new Error("unavailable");
        checks.push({ scope: "sqlite", result: "deleted", verification: "secure_delete=ON; VACUUM; freePages=0; record journal/WAL/SHM inspected absent; temp_store=MEMORY; lifetime-lock files retained" });
      } catch { checks.push({ scope: "sqlite", result: "failed", verification: "compaction or named-file residue verification incomplete; retry required" }); }
      return checks;
    },
    save: (state) => session.transaction(() => {
      session.database.prepare("UPDATE retention SET value=? WHERE id=1").run(JSON.stringify(state));
      fault?.("retention:state:before_commit");
      fault?.(`retention:state:${state.state}:before_commit`);
    }),
  });
}
