import type { Ports, SafeReason } from "./ports.js";
import type { ModelPolicy } from "./model-contract.js";
import { caseRepositories, caseResources } from "./resource-scope.js";

export interface OfflineScope {
  readonly mode: "mock";
  readonly snapshotRef: string;
  readonly resourceRefs?: readonly string[];
  readonly psp?: { readonly sourceRef: "psp-log-source"; readonly repositoryRef: string };
  readonly queryWindow: { readonly from: string; readonly to: string };
  readonly modelPolicy?: ModelPolicy;
  readonly modelProfile?: "memory_mock" | "local_protocol";
}

export interface ReadyScope extends OfflineScope {
  readonly resourceRefs: readonly string[];
}

const requiredPorts = ["admission", "records", "clock", "authorization", "sanitization", "audit", "budget", "logs", "code", "agent", "model", "delivery"] as const;
function complete(ports: Partial<Ports>): ports is Ports { return requiredPorts.every((key) => !!ports[key]); }

export function resolveDependencies(ports: Partial<Ports>, scope?: OfflineScope):
  { readonly status: "ready"; readonly ports: Ports; readonly scope: ReadyScope } |
  { readonly status: "unavailable"; readonly reason: SafeReason } {
  if (!complete(ports) || scope?.mode !== "mock") return { status: "unavailable", reason: "unavailable" };
  const windowSize = Date.parse(scope.queryWindow.to) - Date.parse(scope.queryWindow.from);
  try {
    const resourceRefs = caseResources(scope.resourceRefs ?? ["simulator-source"]);
    if (!scope.snapshotRef || !Number.isFinite(windowSize) || windowSize <= 0 || windowSize > 86_400_000) throw new Error("invalid_request");
    const psp = scope.psp?.sourceRef === "psp-log-source" && resourceRefs.includes(scope.psp.sourceRef) && caseRepositories(resourceRefs).includes(scope.psp.repositoryRef)
      ? Object.freeze(structuredClone(scope.psp)) : undefined;
    const { psp: _unverified, ...validated } = scope;
    return { status: "ready", ports, scope: Object.freeze({ ...validated, resourceRefs, ...(psp ? { psp } : {}) }) };
  } catch { return { status: "unavailable", reason: "invalid_request" }; }
}
