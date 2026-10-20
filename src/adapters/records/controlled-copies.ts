import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DeletionCheck } from "../../troubleshooting/application/retention.js";

export interface ControlledCopy {
  readonly copyRef: string;
  readonly kind: "temporary" | "backup" | "host_copy";
  readonly verificationRef: "synthetic-local-private-files-1";
}

// The only enabled profile is a synthetic private local directory, under this store.
// Unknown host snapshots/backup profiles cannot be enabled by a boolean assertion.
export class ControlledCopies {
  private readonly root: string;
  private readonly copies: readonly ControlledCopy[];

  constructor(directory: string, copies: readonly ControlledCopy[] = []) {
    this.root = join(directory, "controlled-copies");
    this.copies = structuredClone(copies);
    const refs = new Set<string>();
    for (const copy of this.copies) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(copy.copyRef) || refs.has(copy.copyRef) ||
        !["temporary", "backup", "host_copy"].includes(copy.kind) || copy.verificationRef !== "synthetic-local-private-files-1") throw new Error("unavailable");
      refs.add(copy.copyRef);
    }
    this.validate();
  }

  private present(path: string): boolean {
    try { lstatSync(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw new Error("unavailable"); }
  }

  private tree(path: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 ||
      (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error("unavailable");
    if (stat.isDirectory()) for (const name of readdirSync(path)) this.tree(join(path, name));
  }

  validate(): void {
    if (!this.present(this.root)) return;
    this.tree(this.root);
    if (readdirSync(this.root).some((name) => !this.copies.some((copy) => copy.copyRef === name))) throw new Error("unavailable");
  }

  purge(fault?: (point: string) => void): DeletionCheck[] {
    try { this.validate(); } catch { return [{ scope: "controlled_copies", result: "failed", verification: "unverified or unsafe copy remains; cleanup incomplete" }]; }
    return this.copies.map((copy) => {
      try {
        const path = join(this.root, copy.copyRef);
        fault?.(`retention:copy:${copy.copyRef}:before`);
        if (this.present(path)) { this.tree(path); rmSync(path, { recursive: true }); }
        if (this.present(path)) throw new Error("unavailable");
        return { scope: `copy:${copy.copyRef}`, result: "deleted", verification: `${copy.kind}; synthetic-local-private-files-1; named directory absent` };
      } catch { return { scope: `copy:${copy.copyRef}`, result: "failed", verification: "controlled local copy cleanup incomplete; retry required" }; }
    });
  }
}
