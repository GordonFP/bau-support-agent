import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod/v4";
import { McpFailure } from "../mcp/failure.js";

const path = z.string().min(1).max(4096).refine(isAbsolute);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const shape = z.strictObject({
  profile: z.enum(["synthetic-local-1", "local-candidate-1"]),
  factory: z.strictObject({ path, export: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/) }),
  axios: path, stdio: path,
  packages: z.strictObject({ axios: z.strictObject({ path, version: z.enum(["1.12.2", "1.20.0"]) }), sdk: z.strictObject({ path, version: z.enum(["1.20.0", "1.32.1"]) }) }),
  modules: z.array(z.strictObject({ path, sha256: sha })).min(3).max(512),
  backend: z.strictObject({ url: z.string().max(256), apiKey: z.literal("owned-synthetic-key") }),
  index: z.enum(["synthetic-simulator", "synthetic-psp"]),
  manifest: z.strictObject({ server: z.strictObject({ name: z.string().min(1).max(100), version: z.string().min(1).max(50) }),
    protocolVersion: z.enum(["2025-06-18", "2025-11-25"]), capabilities: z.record(z.string(), z.unknown()),
    tools: z.array(z.record(z.string(), z.unknown())).min(1).max(16), searchTool: z.string().min(1).max(80) }),
});
export interface ProfileReference { readonly path: string; readonly sha256: string }
export interface KibanaProfile { readonly reference: ProfileReference; readonly value: z.infer<typeof shape> }
// Explicit host-supplied local G1 control file. This does not discover configuration
// or establish artifact provenance, deployment identity, or permission to redistribute.
export async function loadKibanaProfile(reference: ProfileReference): Promise<KibanaProfile> {
  try {
    if (!isAbsolute(reference.path) || !sha.safeParse(reference.sha256).success) throw new Error();
    const bytes = await readFile(reference.path);
    if (bytes.length > 65_536 || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) throw new Error();
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const bounded = (item: unknown, depth = 0): boolean => depth <= 12 && (item === null || typeof item !== "object" ||
      Object.keys(item).length <= 512 && Object.entries(item).every(([key, value]) => !["__proto__", "constructor", "prototype"].includes(key) && bounded(value, depth + 1)));
    if (!bounded(raw)) throw new Error();
    const value = shape.parse(raw);
    const url = new URL(value.backend.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash || !["/", "/kibana"].includes(url.pathname)) throw new Error();
    if (value.packages.axios.version !== (value.profile === "local-candidate-1" ? "1.12.2" : "1.20.0") || value.packages.sdk.version !== (value.profile === "local-candidate-1" ? "1.20.0" : "1.32.1")) throw new Error();
    if (![value.factory.path, value.axios, value.stdio, value.packages.axios.path, value.packages.sdk.path].every((file) => value.modules.some((entry) => entry.path === file)) ||
      new Set(value.modules.map((entry) => entry.path)).size !== value.modules.length ||
      value.manifest.tools.some((tool) => "outputSchema" in tool) ||
      value.manifest.tools.filter((tool) => tool.name === value.manifest.searchTool).length !== 1) throw new Error();
    return { reference: { path: reference.path, sha256: reference.sha256 }, value };
  } catch { throw new McpFailure("contract_unverified"); }
}
export async function verifyModules(profile: KibanaProfile): Promise<void> {
  try {
    for (const entry of profile.value.modules) if (createHash("sha256").update(await readFile(entry.path)).digest("hex") !== entry.sha256) throw new Error();
  } catch { throw new McpFailure("contract_unverified"); }
}
