import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockTroubleshooting, type MockOptions } from "../../src/adapters/mock/troubleshooting.js";
import { createPiRuntime } from "../../src/adapters/pi/runtime.js";
import { mcpEvidencePorts } from "../../src/adapters/mcp/evidence.js";
import { syntheticManifest, syntheticPspManifest } from "../../src/adapters/mcp/manifest.js";
import { createResponsesGateway, responsesModelPolicy } from "../../src/adapters/model/responses.js";
import { reportIn, sendText, sendTool } from "./responses.js";
import type { ServerResponse } from "node:http";

export function simulatorResponse(body: Record<string, unknown>, response: ServerResponse): void {
  const previous = (body.input as { type?: string; name?: string }[]).filter((item) => item.type === "function_call").map((item) => item.name);
  const name = !previous.includes("logs_read") ? "logs_read" : !previous.includes("code_search") ? "code_search" : null;
  if (name) sendTool(response, { name, done: true, terminal: true });
  else {
    const draft = reportIn(body) as { scene?: string; reportRef?: string; draftVersion?: string };
    sendText(response, JSON.stringify(draft.scene === "psp" ? { reportRef: draft.reportRef, draftVersion: draft.draftVersion } : draft), { synthetic_source: "mock_usage", synthetic_cost_microusd: 1_000 });
  }
}
export async function nativeTroubleshooting(baseUrl: string, options: MockOptions = {}, mode = "normal") {
  const psp = mode.startsWith("psp:");
  const service = fileURLToPath(new URL(psp ? "./psp-service.js" : "./mcp-service.js", import.meta.url));
  const endpoint = { command: process.execPath, args: [service, mode], manifest: psp ? syntheticPspManifest : syntheticManifest,
    artifact: { path: service, sha256: createHash("sha256").update(readFileSync(service)).digest("hex") } };
  const mock = createMockTroubleshooting({ ...options, modelPolicy: responsesModelPolicy, modelProfile: "local_protocol", controlPorts: (ports) => ({
    records: ports.records, ...options.controlPorts?.(ports), ...mcpEvidencePorts(ports, { logs: endpoint, code: endpoint, ...(psp ? { approvedCaseResourceRefs: ["simulator-source", "psp-log-source", "psp-code"], psp: { sourceRef: "psp-log-source" as const, repositoryRef: "psp-code" } } : {}), resolveIdentifier: (_context, identifier) => identifier }),
  }) });
  const pi = await createPiRuntime({ skillPath: resolve("runtime-skills/bau-troubleshooting/SKILL.md"), clock: mock.ports.clock });
  const close = mock.ports.agent.close;
  mock.ports.agent.run = pi.run; mock.ports.agent.abort = pi.abort;
  mock.ports.agent.close = async (caseRef, phaseId) => { await pi.close(caseRef, phaseId); await close(caseRef, phaseId); };
  mock.ports.model.generate = createResponsesGateway({ route: "local_protocol", baseUrl, contract: responsesModelPolicy.protocol, clock: mock.ports.clock }).generate;
  return { mock, pi };
}
