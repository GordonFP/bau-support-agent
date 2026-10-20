# #26 — native Codebase Memory snapshots and bounded code evidence

Scope: local synthetic G0/G1 execution for [#26](https://github.com/GordonFP/bau-support-agent/issues/26), under [#14](https://github.com/GordonFP/bau-support-agent/issues/14). No internal GitLab, production source, real model, tenant, credentials or deployment was used. These results do not establish POC Go or close the parent.

## Implementation

- The already confirmed B `CodeEvidence.search / snippet / trace` operations now have closed DTOs and Mock contracts. Application calls retain the existing 30 second tool cap, current authorization, audit, case target, evidence acceptance, records and report validation. Pi continues to expose only its reviewed two host tools; native tools are not registered directly.
- `OfflineScope.resourceRefs` is an optional trusted bootstrap list, validated as one to three unique aliases including `simulator-source`, then copied and frozen. It defaults to the existing single source. Log and code profiles use the same immutable case context, snapshot and shared `McpBoundary`; repository-specific authorization uses derived narrow copies. A model cannot install scope, snapshot, process, endpoint or native options.
- The native read profile checks all thirteen advertised analysis-tool fingerprints and the exact server/protocol before invoking only `search_code`, `search_graph`, `get_code_snippet` or `trace_path`. Management, `manage_adr` in every mode, project enumeration, raw Cypher/SQL, prompts and resources are not application tools. Searches compile literal bounded source terms or bounded graph terms; exact qualified symbols and receipt-listed relative files are required for snippets. Direction, depth, row/token limits and native options are host controlled.
- Native compact tables, nested source objects and grouped trace rows are translated to application evidence. Duplicate text and structured representations count as wire bytes but are accepted once. The shared boundary retains 1 MiB cumulative raw receive accounting, 16 KiB fragment limits including labels, 256 KiB case evidence accounting across profiles and phases, current fences and raw resource cleanup ownership.
- Code evidence contains repository alias, main/master, commit, locator, selected collection, index time and the collection SHA-256 receipt. The case target comes from a trusted host resolver, not graph content or model arguments. Static relationships are explicitly separated from execution facts and historical production deployment versions.

## Independent management and immutable publication

`management/codebase-snapshot.ts` is a technical CLI, outside the BAU/Pi tool set. Its fixed local-synthetic profile accepts only an explicit `http://127.0.0.1:<port>/` GitLab substitute. It calls the documented branch REST route and performs actual Git smart-HTTP single-branch clones. Only explicitly configured main/master branches are accepted, metadata commit and checkout must agree, and the configuration has at most three repositories. No credential or arbitrary remote discovery is provided.

The CLI takes an exclusive update lock, rejects new B read leases and waits for existing readers to drain. It builds every selected index and every explicit cross-repository target set, rejects partial/skipped/unusable construction, checks stored graph Branch provenance and recorded index generation, and hashes source bytes before and after building. It confirms no native producer remains in the private process namespace before copying SQLite bytes. Only after every source/DB and cross-repository receipt is complete does it publish a read-only directory and atomically rename `current.json`. A failed update retains the complete previous receipt and a finite failure-phase record. Unknown writers leave the lock closed; stale reader/writer ownership requires administrative reconciliation and is never automatically discarded.

After building the project, an administrator invokes `node dist/management/codebase-snapshot.js /absolute/local-synthetic.json`. The owned local GitLab substitute must already be running. For example, the external configuration has this closed shape (paths and port are local placeholders):

```json
{
  "mode": "local_synthetic",
  "root": "/controlled/snapshots",
  "docker": "/usr/local/bin/docker",
  "binary": "/controlled/artifacts/codebase-memory-mcp",
  "image": "sha256:df76f23de89b7a36c1ada0f9a5b8d14e63169547479eaef955cc0e7c74d6e29a",
  "gitlab": "http://127.0.0.1:43100/",
  "repositories": [
    { "repositoryRef": "simulator-source", "project": "simulator", "projectId": 1, "branch": "main" },
    { "repositoryRef": "estimate-source", "project": "estimate", "projectId": 2, "branch": "master" }
  ]
}
```

Success writes one immutable receipt to stdout. The host passes its `snapshotRef` and exact resource set to the application and both evidence profiles, constructs one `McpBoundary` after final lifecycle/sanitization ports, and supplies `localReadService` only in this G1 administrator/test composition. No command, config path or snapshot management operation is exposed to Pi.

A collection represents one exact resource security scope. A narrower account uses its own independently indexed collection, rather than a cross-linked database from a broader account. Every repository in the collection is currently authorized before the native service can start; an explicitly declared cross-repository target is also checked before any physical query. Before and after each query, the Adapter checks the receipt, its construction proof, every matching source digest and every DB digest. HEAD, ready, coverage metadata and an index timestamp alone are not relied on.

The G1 controller in `management/codebase-docker.ts` is used by the administrator/test host. It starts a separate non-root container per owned read or management scope with init, network none, read-only root/source/DB mounts, a private writable config/activity/log cache, 2 CPUs, 1536 MiB and pids=128. Start ownership is registered before its first await. Cleanup awaits any original pending start, stops the whole named container and confirms exact absence before releasing its read lease. Once a create request was dispatched, a failed/expired CLI leaves cleanup cached as rejected even if a current inspect says absent: a late create remains possible. The reader lease and C partial state remain held for independent administrative reconciliation. The contract test demonstrates this with an owned real container created after the failed command and first absent inspect; reconciliation does not silently reset the retired controller's unknown result. Local validation failures before dispatch can close without a resource. This controller is not a production app dependency; it does not put Docker CLI/socket credentials into the BAU runtime or change the portable application's 512 MiB/pids=64 validation profile.

## Actual fixed artifact and native limitations

The external portable Linux arm64 artifact remains Codebase Memory **0.12.1**, fixed public source `a7158ac2f48ca646b4527341b76f930f2aeff87e`. Archive SHA-256 is `ed0f1f548cd79b121c401c2e9f7841c189a001af26d3768368088c24f6a53533`; extracted 331,161,408 byte binary SHA-256 is `6a64e20e2ca8dc15b4a412e981e5aea60804ed3e952d693ab491c93ccd36ed45`. Binary/source/archive and temporary indices remain outside Git. No dependency or artifact variant was changed.

The previously verified Sigstore message signature, independent GitHub SLSA and signed SPDX receipts, including negative digest/identity checks, are reused from controlled local research. The binary actually executes as AArch64 without PT_INTERP on the cached Debian 12/glibc 2.36 research image `sha256:df76f23de89b7a36c1ada0f9a5b8d14e63169547479eaef955cc0e7c74d6e29a`. This is an already cached research image, not a newly approved final production image or reproducible image build.

Native observations preserve these limits:

- Index coverage itself is `best_effort`. Complete construction and matching source/graph receipts do not prove that every language or possible relation was indexed. Zero hits never establish absence.
- Synthetic fetch/Express repositories produce **non-zero** bidirectional cross-repository construction receipts. However the fixed `trace_path(mode=cross_service)` response drops destination project/handler edge properties and returns a local route with null strategy/confidence. That result is `unknown`, truncated/partial, and explicitly says the destination is not proven. The host does not invent a remote handler, enable `query_graph`, or broaden native fields to repair it. Separate target code evidence remains separate evidence.
- A deliberate source-only mutation after the pre-query check reproduces the native graph/snippet inconsistency and is rejected by the post-query digest check. Identical HEAD/graph metadata is insufficient.
- An active same-account daemon refuses a second cache directory. A cache path is not an ACL. The native tests separately observe missing unauthorized source/DB mounts and effective EROFS/EACCES writes, with distinct management and read containers.

The top-level MIT license does not clear redistribution. Existing material gates remain: static glibc/GCC/zlib provenance and required notices/relink materials, Adobe AFM permission/provenance, detailed transitive/image inventory and final image clearance. The signed coarse SBOM is not a complete binary composition or security assessment. The dynamic same-version alternative was not selected or run.

The exact-source SQLite follow-up verifies nine public source blobs and four official SQLite documents. CBM embeds SQLite 3.51.3 with FTS5 and defensive mode off in the reviewed default source configuration; its actual runtime flag was not measured. The arbitrary-SQL prerequisite of CVE-2026-11822/11824 is conditionally absent from these closed ordinary read routes only while host arguments, named read-only project selection, owned management-generated frozen DB/source and physical isolation hold. Fixed cross-service traversal chooses internal edge constants and uses the same bound BFS SQL, and does not expose SQL. Hostile database/index generation, parser bugs, other optional modes and general native memory safety remain unassessed. Node's separate SQLite does not patch CBM. These are scoped findings, not security or legal clearance.

## Verification

Executed native contract scenarios use the real fixed binary and real Git HTTP backend, through the CLI and existing B/A/C/D boundaries. They cover four converters, multiple repositories and branches, non-zero cross construction, lossy trace truth, per-end denial, partial third-index failure, failed synchronization, full atomic replacement, read draining/new-admission refusal, source drift, bounded partial results, pending-start cancellation, whole-container cleanup, physical scope/write protection and same-account daemon behavior. Portable behavior tests cover closed DTO refusal, host-scope validation and application snippet/trace evidence acceptance.

Actual verification on 2026-10-21, after merging the final #25 artifact-closure hardening (`432366be`), using Node 24.22.0 and TypeScript 7.0.2:

- `npm run typecheck`, `npm run build`, `scripts/check-pi-types.mjs`, `scripts/check-teams-types.mjs` and `scripts/check-teams-interop.mjs` passed. The code Adapter and management source/type closure additionally passed strict checking with `--skipLibCheck false`. The approved inherited project setting remains; strict native Pi/Teams consumers reject invalid input. This does not repair the documented Pi vendor declarations.
- All **298** portable behavior tests passed on macOS arm64 with `--test-concurrency=2` and Linux arm64 in the original network-none, read-only-root/checkout, 512 MiB/pids=64/64 MiB tmpfs profile. Docker CLI/socket and the native controller were not added to that application container. A first fully parallel macOS run had one existing 250 ms deadline test return `unavailable` instead of `timeout` under concurrent native/Postman load; its isolated rerun and the full controlled-concurrency rerun passed without changing its assertion or deadline.
- All **11** native contract tests passed with the actual fixed CBM binary in the separate owned Linux arm64 containers controlled from the macOS Node host. The two mixed tests additionally require the explicit reviewed external Kibana candidate; no synthetic fallback is accepted. Actual Pi 1.3.0 → local Responses → native Kibana/owned ES plus multi-repository CBM share one boundary, immutable full scope and code snapshot, then produce an honest unknown-readiness report through A/C/D. Exported records, model requests and delivery pass sensitive/private-path canary checks. A separate test confirms a log result fits alone but is refused after native snippets charge earlier phases of the same case's 256 KiB allowance.
- All **3** model/Kibana Postman contract tests passed with local Postman CLI simulations. No cloud workspace or provider request was used.
- The offline SQLite receipt verifier again matched all nine reviewed public source blobs and four official documents. `git diff --check` passed. External artifacts, private candidate control/config/source, cloned repositories and generated indices are not committed.

## Sources and outstanding environment gates

Primary sources: [fixed release](https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.12.1), [fixed native tool implementation](https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/mcp/mcp.c), [fixed bidirectional cross-repository construction](https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/pipeline/pass_cross_repo.c), [fixed daemon/frontend lifecycle](https://github.com/DeusData/codebase-memory-mcp/blob/a7158ac2f48ca646b4527341b76f930f2aeff87e/src/main.c), [GitLab branch API](https://docs.gitlab.com/api/branches/#get-single-repository-branch), [Git smart-HTTP backend](https://git-scm.com/docs/git-http-backend), [SQLite official CVE table](https://sqlite.org/cves.html).

Not executed or claimed: internal GitLab synchronization/authorization, real credentials, production deployment-version linkage, production service identities/storage/network or final image validation, real Kibana/Teams/model environment, real diagnostic quality or POC Go. Real routes remain subject to their separate approvals and G3 checks; the local controller and synthetic protocol service do not establish them.
