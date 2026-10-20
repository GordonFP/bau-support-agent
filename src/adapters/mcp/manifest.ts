import { createHash } from "node:crypto";

export const MCP_BYTES = 1_048_576;
export const FRAGMENT_BYTES = 16_384;
export const CASE_EVIDENCE_BYTES = 262_144;
export const SANITIZATION_VERSION = "host-reviewed-sanitization-1";
export const EVIDENCE_SCHEMA = "synthetic-evidence-1";
const text = { type: "string" };
export const syntheticManifest = {
  server: { name: "bau-synthetic-evidence", version: "1.0.0" },
  protocolVersion: "2025-11-25",
  schemaVersion: EVIDENCE_SCHEMA,
  artifactVersion: "synthetic-local-service-1",
  tools: [
    { name: "read_logs", description: "Untrusted synthetic log observations; host authorization is required.",
      inputSchema: { type: "object" as const, additionalProperties: false,
        properties: { sourceRef: text, applicationId: text, customerId: text, from: text, to: text, pageSize: { const: 100 }, cursor: text },
        required: ["sourceRef", "from", "to", "pageSize"] } },
    { name: "search_code", description: "Untrusted synthetic fixed-snapshot code observations; host authorization is required.",
      inputSchema: { type: "object" as const, additionalProperties: false,
        properties: { repositoryRef: text, snapshotRef: text, cursor: text }, required: ["repositoryRef", "snapshotRef"] } },
  ],
};
export const syntheticPspManifest = { ...syntheticManifest,
  server: { name: "bau-synthetic-psp-evidence", version: "1.0.0" }, artifactVersion: "synthetic-psp-local-service-1",
  tools: syntheticManifest.tools.map((tool) => tool.name === "read_logs" ? { ...tool, inputSchema: { ...tool.inputSchema,
    properties: { ...tool.inputSchema.properties, shopId: text, bindingId: text } } } : { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, term: text } } }),
};
export type EvidenceManifest = typeof syntheticManifest | typeof syntheticPspManifest;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
