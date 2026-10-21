import type { Ports, SafeReason } from "./ports.js";
import type { ModelPolicy } from "./model-contract.js";
import { verifiedModelPolicy } from "./model-envelope.js";
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

export interface ReadyScope extends Omit<OfflineScope, "resourceRefs" | "modelPolicy" | "modelProfile"> {
  readonly resourceRefs: readonly string[];
  readonly model: { readonly state: "enabled"; readonly profile: "memory_mock" | "local_protocol"; readonly policy: ModelPolicy } |
    { readonly state: "disabled"; readonly profile: "memory_mock" | "local_protocol" };
}

const requiredPorts = ["admission", "records", "deliveryLedger", "clock", "authorization", "sanitization", "audit", "budget", "logs", "code", "agent", "model", "delivery"] as const;
function complete(ports: Partial<Ports>): ports is Ports { return requiredPorts.every((key) => !!ports[key]); }

export function resolveDependencies(ports: Partial<Ports>, scope?: OfflineScope):
  { readonly status: "ready"; readonly ports: Ports; readonly scope: ReadyScope } |
  { readonly status: "unavailable"; readonly reason: SafeReason; readonly pspConfigured: boolean } {
  let resourceRefs: readonly string[] | undefined;
  try { resourceRefs = caseResources(scope?.resourceRefs ?? ["simulator-source"]); } catch { /* invalid scope stays unavailable */ }
  const psp = scope?.psp?.sourceRef === "psp-log-source" && resourceRefs?.includes(scope.psp.sourceRef) && caseRepositories(resourceRefs).includes(scope.psp.repositoryRef)
    ? Object.freeze(structuredClone(scope.psp)) : undefined;
  const pspConfigured = psp !== undefined;
  if (!complete(ports) || scope?.mode !== "mock") return { status: "unavailable", reason: "unavailable", pspConfigured };
  try {
    const windowSize = Date.parse(scope.queryWindow.to) - Date.parse(scope.queryWindow.from);
    if (!scope.snapshotRef || !resourceRefs || !Number.isFinite(windowSize) || windowSize <= 0 || windowSize > 86_400_000) throw new Error("invalid_request");
    const profile = scope.modelProfile ?? "memory_mock";
    const policy = verifiedModelPolicy(scope.modelPolicy);
    const model: ReadyScope["model"] = policy && profile === (policy.protocol === "mock-json-byte-pairs-1" ? "memory_mock" : "local_protocol")
      ? { state: "enabled", profile, policy } : { state: "disabled", profile: profile === "local_protocol" ? profile : "memory_mock" };
    const { psp: _unverified, modelPolicy: _policy, modelProfile: _profile, ...validated } = scope;
    return { status: "ready", ports, scope: Object.freeze({ ...validated, queryWindow: Object.freeze({ ...scope.queryWindow }), resourceRefs, model: Object.freeze(model), ...(psp ? { psp } : {}) }) };
  } catch { return { status: "unavailable", reason: "invalid_request", pspConfigured }; }
}
