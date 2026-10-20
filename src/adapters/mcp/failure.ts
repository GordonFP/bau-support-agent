import type { SafeReason } from "../../troubleshooting/application/ports.js";

export class McpFailure extends Error {
  constructor(readonly reason: SafeReason) { super(reason); }
}
