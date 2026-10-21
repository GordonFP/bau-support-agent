import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Run the exact reviewed standalone HTTP mock, including its raw-body path.
export async function localProtocolMock(name: "responses" | "kibana") {
  const directory = await mkdtemp(join(tmpdir(), "bau-protocol-mock-"));
  const reserved = createServer(); await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", resolve));
  const address = reserved.address(); if (!address || typeof address === "string") throw new Error("unavailable");
  await new Promise<void>((resolve) => reserved.close(() => resolve()));
  const script = join(directory, "mock.cjs"); await copyFile(resolve(`postman/mocks/${name}/default.js`), script);
  const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, PORT: String(address.port) }, stdio: "ignore" });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const close = async () => { if (child.exitCode === null) { child.kill(); await new Promise<void>((resolve) => child.once("exit", () => resolve())); } await rm(directory, { recursive: true, force: true }); };
  try {
    const deadline = performance.now() + 2_000;
    for (;;) { try { await fetch(baseUrl); break; } catch { if (performance.now() >= deadline || child.exitCode !== null) throw new Error("unavailable"); await new Promise((resolve) => setTimeout(resolve, 10)); } }
    return { baseUrl, close };
  } catch (error) { await close(); throw error; }
}
