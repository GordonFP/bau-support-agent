import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { reviewedSkill, REVIEWED_SKILL_SHA256 } from "../adapters/pi/skill.js";
import { mockModelPolicy } from "../troubleshooting/application/model-envelope.js";

const versions = { "@earendil-works/pi-ai": "1.3.0", "@earendil-works/pi-coding-agent": "1.3.0",
  "@microsoft/teams.apps": "2.1.1", "@microsoft/teams.api": "2.1.1", "@microsoft/teams.common": "2.1.1",
  "@modelcontextprotocol/sdk": "1.32.1", "@opentelemetry/api": "1.9.1", zod: "4.6.7", typebox: "1.3.27" } as const;
Object.freeze(versions);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const disabled = (stage: string, missing: readonly string[]) => Object.freeze({ state: "disabled" as const, stage, missing: Object.freeze([...missing]) });

// Installed metadata is checked, not treated as proof of a running native server.
export async function runtimeGates() {
  if (process.versions.node !== "24.22.0" || process.env.NODE_OPTIONS || process.env.OPENAI_LOG && process.env.OPENAI_LOG !== "off" ||
    Object.keys(process.env).some((name) => name.startsWith("OTEL_")) || process.execArgv.some((value) => value === "-r" || /^--(require|import|loader|experimental-loader)(=|$)/.test(value))) throw new Error("contract_unverified");
  for (const [name, version] of Object.entries(versions)) {
    const installed: unknown = JSON.parse(await readFile(new URL(`../../../node_modules/${name}/package.json`, import.meta.url), "utf8"));
    if (!installed || typeof installed !== "object" || !("name" in installed) || installed.name !== name || !("version" in installed) || installed.version !== version) throw new Error("contract_unverified");
  }
  await reviewedSkill(fileURLToPath(new URL("../../../runtime-skills/bau-troubleshooting/SKILL.md", import.meta.url)));
  return Object.freeze({
    artifacts: Object.freeze({ node: process.versions.node, packages: versions, skillSha256: REVIEWED_SKILL_SHA256,
      modelPolicySha256: hash(mockModelPolicy), mockToolAllowlistSha256: hash(["logs_read", "code_search"]), protocol: mockModelPolicy.protocol }),
    mock: Object.freeze({ state: "ready" as const, stage: "G0", scope: "synthetic_only" }),
    localProtocols: disabled("G1", ["external_contract_evidence_is_not_an_enabled_in_image_route"]),
    cpa: disabled("G2", ["route_not_implemented", "deployment_model_api_account_mapping", "pre_generation_total_output_limit",
      "proven_all_charge_upper_bound", "network_credentials_retention_retry_cancel_usage", "synthetic_data_only_no_business_credentials"]),
    company: disabled("G3", ["route_not_implemented", "company_gateway_policy_model_api_sku_geography_fees", "scoped_operator_resource_audience_expiry_approval",
      "actual_protocol_network_identity_storage_readonly_proof"]),
    teams: disabled("G3", ["actual_tenant_service_and_user_proof", "private_audience_approval_and_revocation", "deployed_network_identity"]),
    logs: disabled("G3", ["actual_readonly_identity_index_acl", "approved_field_timezone_association_mapping", "fixed_deployment_manifest_and_network"]),
    code: disabled("G3", ["external_artifact_not_bundled", "independent_management_identity", "approved_repository_snapshot_and_physical_readonly_scope"]),
    storage: disabled("G3", ["host_encryption_and_key_evidence", "production_volume_lock_and_flush_semantics", "controlled_copy_permission_and_expiry_proof"]),
    groups: disabled("G3", ["complete_actual_and_historical_audience_approval"]),
    backups: disabled("G3", ["host_copy_acl_and_due_deletion_verification"]),
    evaluation: disabled("G4", ["G3", "frozen_authorized_twelve_plus_twelve_real_cases", "qualified_review_and_complete_actual_run_costs", "owner_go_decision"]),
  });
}
