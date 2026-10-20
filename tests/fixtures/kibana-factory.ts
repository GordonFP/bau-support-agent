import axios from "axios";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { syntheticSearch } from "./kibana.js";
// Owned fixture deliberately reproduces the observed lossy text conversion. It is
// distinct from the externally controlled candidate and carries its own identity.
export function createSyntheticServer(config: { kibana: { url: string; apiKey: string }; logLevel: string }) {
  const client = axios.create({ baseURL: config.kibana.url, timeout: 30_000, headers: { Authorization: `ApiKey ${config.kibana.apiKey}`, "kbn-xsrf": "true" } });
  const server = new Server({ name: "owned-synthetic-kibana", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [syntheticSearch] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name !== syntheticSearch.name) throw new Error("unknown tool");
    try { const { index, query, size, from, sort } = params.arguments!;
      const response = await client.post("/internal/search/es", { params: { index, body: { query, size: Math.min(Number(size ?? 10), 100), from, sort } } });
      const data = response.data.rawResponse ?? response.data;
      return { content: [{ type: "text", text: JSON.stringify({ took: data.took, total: data.hits.total, hits: data.hits.hits.map(({ _id, _index, _score, _source }: any) => ({ _id, _index, _score, _source })) }) }] };
    } catch { return { isError: true, content: [{ type: "text", text: "untrusted backend failure" }] }; }
  });
  return server;
}
