import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { openMockRuntime } from "./runtime.js";

async function configuration(): Promise<unknown> {
  if (process.argv.length > 3) throw new Error("invalid_request");
  const path = process.argv[2] ?? process.env.BAU_CONFIG ?? "/etc/bau/runtime.json";
  if (!isAbsolute(path)) throw new Error("invalid_request");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384) throw new Error("invalid_request");
    const bytes = Buffer.alloc(16385); const result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > 16384) throw new Error("invalid_request");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, result.bytesRead)));
  } finally { await file.close(); }
}
try {
  const runtime = await openMockRuntime(await configuration());
  // Mock has no network listener; the process owns the store until host shutdown.
  const lifetime = setInterval(() => {}, 3_600_000);
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      const state = await runtime.close();
      process.stdout.write(`${JSON.stringify({ event: "shutdown", state })}\n`, () => {
        clearInterval(lifetime);
        if (state !== "closed") process.exit(1); // Explicit forced local end, never a graceful-close claim.
      });
    })();
  };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  process.stdout.write(`${JSON.stringify({ event: "ready", profile: "mock", gates: runtime.gates })}\n`);
} catch { process.stderr.write("runtime_unavailable\n"); process.exitCode = 1; }
