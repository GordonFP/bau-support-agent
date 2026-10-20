import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export class SqliteSession {
  readonly database: DatabaseSync;
  readonly directory: string;
  private readonly lock: DatabaseSync;
  private closed = false;

  constructor(directory: string) {
    if (!isAbsolute(directory) || lstatSync(directory).isSymbolicLink()) throw new Error("unavailable");
    const root = realpathSync(directory);
    this.directory = root;
    const stat = lstatSync(root);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("unavailable");
    const lockPath = join(root, "runtime-lock.sqlite");
    const recordsPath = join(root, "records.sqlite");
    for (const path of [lockPath, recordsPath]) {
      let file;
      try { file = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("unavailable"); }
      if (file && (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o077) !== 0 || file.uid !== stat.uid)) throw new Error("unavailable");
    }
    let lock: DatabaseSync | undefined;
    let database: DatabaseSync | undefined;
    try {
      lock = new DatabaseSync(lockPath, { timeout: 0, allowExtension: false });
      chmodSync(lockPath, 0o600);
      lock.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;");
      database = new DatabaseSync(recordsPath, { timeout: 0, allowExtension: false, enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false });
      chmodSync(recordsPath, 0o600);
      database.exec("PRAGMA journal_mode=DELETE; PRAGMA locking_mode=NORMAL; PRAGMA synchronous=EXTRA; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF;");
      for (const [setting, expected] of [["synchronous", 3], ["secure_delete", 1], ["temp_store", 2], ["trusted_schema", 0]] as const) {
        if (Object.values(database.prepare(`PRAGMA ${setting}`).get() ?? {})[0] !== expected) throw new Error("unavailable");
      }
      this.lock = lock;
      this.database = database;
    } catch {
      database?.close();
      if (lock?.isTransaction) lock.exec("ROLLBACK");
      lock?.close();
      throw new Error("unavailable");
    }
  }

  transaction<T>(operation: () => T): T {
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw new Error("unavailable");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
    if (this.lock.isTransaction) this.lock.exec("ROLLBACK");
    this.lock.close();
  }
}
