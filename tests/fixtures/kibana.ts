import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const syntheticSearch = { name: "synthetic_search", description: "Owned synthetic search fixture.", inputSchema: {
  type: "object", properties: { index: { type: "string" }, query: { type: "object" }, size: { type: "number" }, from: { type: "number" }, sort: { type: "array" } }, required: ["index"] } };
export const logRow = (n = 1) => ({ _id: `e${String(n).padStart(4, "0")}`, _index: "synthetic-simulator", _score: null,
  _source: { event_id: `e${String(n).padStart(4, "0")}`, event_time: "2026-10-18T23:00:00.000Z", application_id: "SYNTHETIC-SECRET-APPLICATION",
    customer_id: "SYNTHETIC-SECRET-CUSTOMER", submitted_at: "2026-10-18T10:00:00.000Z", business_timezone: "Asia/Singapore",
    submitted_shops: [{ shop_id: "shop-1", authorization: "active", coverage_start: "2026-10-01", coverage_through: "2026-10-18", continuous_coverage: true }] } });
export function esBody(rows = [logRow()], total = rows.length) { return { took: 1, timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: total, relation: "eq" }, hits: rows } }; }
export async function kibanaServer(handler?: (body: Record<string, any>, response: ServerResponse) => unknown | Promise<unknown>) {
  const requests: { path: string; body: Record<string, any>; headers: object }[] = [];
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) { raw += String(chunk); if (Buffer.byteLength(raw) > 65_536) { response.writeHead(413).end(); return; } }
    if (request.method !== "POST" || request.url !== "/internal/search/es") { response.writeHead(501).end(); return; }
    try { const body = JSON.parse(raw) as Record<string, any>; requests.push({ path: request.url, body, headers: request.headers });
      if (handler) await handler(body, response); else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rawResponse: esBody() }));
    } catch { response.writeHead(400).end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address !== "object") throw new Error("fixture_unavailable");
  return { requests, url: `http://127.0.0.1:${address.port}`, close: async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}
export async function kibanaProfile(url: string, override?: (value: any) => void) {
  const directory = await mkdtemp(join(tmpdir(), "bau-kibana-"));
  const external = process.env.BAU_KIBANA_TEST_ARTIFACT_CONFIG;
  let value: any;
  if (external) value = JSON.parse(await readFile(external, "utf8"));
  else {
    const require = createRequire(import.meta.url);
    const axiosRoot = dirname(require.resolve("axios/package.json"));
    const factory = fileURLToPath(new URL("./kibana-factory.js", import.meta.url));
    const axios = join(axiosRoot, "index.js");
    const stdio = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
    value = { profile: "synthetic-local-1", factory: { path: factory, export: "createSyntheticServer" }, axios, stdio,
      packages: { axios: { path: join(axiosRoot, "package.json"), version: "1.20.0" }, sdk: { path: join(dirname(stdio), "../../../package.json"), version: "1.32.1" } },
      modules: [factory, fileURLToPath(import.meta.url), axios, stdio, join(axiosRoot, "package.json"), join(dirname(stdio), "../../../package.json")].map((path) => ({ path, sha256: "" })),
      manifest: { server: { name: "owned-synthetic-kibana", version: "1.0.0" }, protocolVersion: "2025-11-25", capabilities: { tools: {} }, tools: [structuredClone(syntheticSearch)], searchTool: "synthetic_search" } };
    for (const entry of await readdir(join(axiosRoot, "lib"), { recursive: true })) {
      if (entry.endsWith(".js")) value.modules.push({ path: join(axiosRoot, "lib", entry), sha256: "" });
    }
    for (const module of value.modules) module.sha256 = createHash("sha256").update(await readFile(module.path)).digest("hex");
  }
  value.backend = { url, apiKey: "owned-synthetic-key" }; value.index = "synthetic-simulator";
  override?.(value);
  const path = join(directory, "controlled.json"); const content = JSON.stringify(value); await writeFile(path, content, { mode: 0o600 });
  return { path, sha256: createHash("sha256").update(content).digest("hex"), close: () => rm(directory, { recursive: true, force: true }) };
}
