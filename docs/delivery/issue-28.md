# #28 — single-instance Mock image and staged capability checks

Local synthetic G0/G1 delivery for [#28](https://github.com/GordonFP/bau-support-agent/issues/28), under [#14](https://github.com/GordonFP/bau-support-agent/issues/14). Started from clean integration `65508fd3e21ff35730ebe1593207ce3fa82286a9` after #27 closed. No production/model/tenant/internal GitLab access, registry upload, cloud deployment or real-route enablement occurred. #30/#31/#32 and the parent remain incomplete; no POC Go is implied.

## Runtime

The entrypoint accepts only the closed schemaVersion1 Mock configuration and a required absolute record-directory reference. It checks exact Node/installed package metadata and the reviewed two-scenario Skill, then opens the existing SQLite records/admission/audit/budget/retention together and commits a startup audit before returning Mock ready. There is no business HTTP listener, new business API or model-controlled module/endpoint/credential/native configuration. Synthetic Simulator and PSP use the final #27 contracts and existing A–D boundaries, including the bounded frozen PSP draft selection.

Capability results distinguish Mock readiness from disabled actual routes. CPA lists missing deployment/model/API/account, pre-generation output and all-charge bound, network/retention/retry/cancellation/usage evidence and synthetic-only/no-business-credentials restrictions. Company, Teams, logs, code, groups, storage, backups and evaluation list their separate unmet G3/G4 evidence. Config-supplied `verified:true`, URLs, credentials, replica settings and unknown fields are refused. Installed metadata, Mock allowlist/model-policy hashes and the Skill hash are identified as such; no running native-server manifest or actual deployment identity is inferred.

The existing lifetime SQLite lock owns the private UID directory across the process. Missing/unwritable/unsafe/wrong-owner stores and unreliable startup audit fail closed, with no in-memory/anonymous replacement. Host close shuts admission and retains original application/Agent/control work. One cached five-second local waiting deadline returns closed or unknown; records close only after original work really ends. Unknown shutdown is explicitly followed by a failed/forced local process exit, not an external-cancellation claim. Stop never triggers retention deletion or budget reset. Restart marks unfinished cases interrupted and preserves dedupe, unknown delivery, fees and unsettled calls; it never restores investigation/model/send work.

`deployment/` supplies a default Mock config, single-replica/Recreate Kubernetes blueprint, private record-PVC and separate Secret/source/key/network/approval placeholders. Those references are not consumed as self-attested enablement. The Kubernetes example is neither applied nor pull-verified. Actual CSI lock/flush, host encryption/key/copy expiry, credentials/resource/audience approvals and actual model cost/protocol remain missing; backups and groups stay disabled.

## Image and source identity

The exact cached Linux arm64 Node base remains `node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`, with separate base config ID `sha256:b3b84798a1d94a7e155f059b3a2f125725578d0738e404fd6d976cf2dcd11912`. Production dependencies install from the unchanged lock in Linux with lifecycle scripts disabled, no audit/fund calls or copied host npm configuration. No dependency/version/lock change was made.

The runtime copies only application adapters/troubleshooting/bootstrap, production dependencies, the reviewed Skill, closed placeholder config and applicable notice material. Tests, management/controller, evaluation administration, references, external native binaries/source/DBs, private Kibana material, Docker CLI/socket and host caches are excluded. The app runs UID1000, root read-only, network none, all capabilities dropped/no-new-privileges, CPU1, 512 MiB, pids64 and private 64 MiB tmpfs, with one explicit persistent record volume. Local volume initialization is checked as actual UID1000/mode0700; the app does not chown or repair existing storage.

The first clean `6c7d21c` build/save produced a local image and archive, but the build wrapper stopped unverified at an OCI CLI argument-count error. The fixed host converter reused that exact archive rather than fabricating a receipt or redownloading a base. Later source exploration identified that Git cleanliness plus ordinary tsc did not exclude ignored extra TypeScript or orphan dist JS. The canonical source path was consequently changed to compile a fixed Git archive in fresh owned staging and compare all actual application file paths/bytes/SHA256 to that fresh output. The original image/OCI remain historical evidence; final source-binding verification is recorded below.

The retained, actually runnable artifact is built from `6c7d21cc002e1dfe050353d6d9dde79a48dbcce3`. Fresh fixed-source compilation matched all **65** in-image application files byte for byte, while the technical contract simultaneously seeded both an ignored extra TypeScript file and stale host dist JavaScript and proved neither entered that output. The build tool now uses only this fresh Git archive tree as Docker context and refuses an application inventory difference; its later host-only fixes do not change the retained application bytes. The source isolation test first failed because that preparation command did not yet exist, then passed after implementation. The unsafe earlier build path was identified by tracing inputs, not by claiming the measured image had contained a canary or secret.

| Actual local identity | SHA256 |
| --- | --- |
| OCI image manifest | `b446e582d5d914c44671beed411991616b23d9ba8d458a4ddfc1201804e266e0` |
| OCI index | `abba4c6a71edc22651ab950ef3af2b222d0795d04b72536ae64ba2fa27284e80` |
| Docker runnable config | `2a35913e6a20e99a1cd0b4bd2fe35488ed95fa1cad6640556c8bc1a200d8fe54` |
| Docker-save archive | `a60955d402ef941c07ace0d111898f3b22b7b51d2e1c1d89a8765e0213f9aa68` |
| Exact-image inventory | `3f9d5f49075db252e452cca9cc432cf5d59d1109a790e8e314f601110d796198` |

The local OCI layout contains 15 ordered layers / 17 content blobs. The Docker-save archive and OCI layout are retained outside Git; no duplicate large artifact was generated merely to change a host verification script. The checked lock hash is `e77e5783fa35a84b5d110111d337e13198bdde93b3db67453ec2ecf32db42ecc`; Skill SHA256 remains `e204643dabd38e47d884b5aee74846b060e18fee46a50b3a6ddfd336f3d16a69`.

Docker 29.4/Buildx0.33 uses the classic docker/overlay2 builder locally. The chosen host-only conversion preserves Docker-save config bytes and ordered layer streams, checks their DiffIDs, and writes an OCI layout with verified descriptor sizes/hashes/media types. Independent CLI checks refuse missing/corrupt blobs, wrong size/platform and reordered layers, including with Python optimization enabled. It records **different** image-manifest, index, config and Docker-save archive digests, and maps the runnable Docker config/ordered RootFS DiffIDs to that layout. No registry manifest, remotely pullable reference, signature or byte-reproducible publisher build is claimed. [Docker exporter scope](https://docs.docker.com/build/exporters/oci-docker/), [OCI layout](https://raw.githubusercontent.com/opencontainers/image-spec/v1.1.1/image-layout.md), [OCI config/DiffIDs](https://raw.githubusercontent.com/opencontainers/image-spec/v1.1.1/config.md)

## Actual contents, notices and security limits

The measured Linux production image contains **242 packages / 22,395 regular package files**, Node24.22.0 (modules137/N-API10), Node SQLite3.53.4 and **88** exact Debian package rows. Full external inventory hashes every installed package/application file, records lock SRI association and maps every OS package to its actual copyright file. There are **256** retained base notice logical paths, including all 17 common-license texts and the two logical copyright aliases. Paths are deduplicated by logical path, not by content across package attributions. A first filename walk counted237 and was not treated as complete. Original package assets, Node/npm/Corepack/Yarn/Debian texts remain in the image; they were not stripped for size.

Nineteen supplemental verbatim grants plus the original OpenTelemetry header extraction preserve fixed public-source provenance and hashes in `notices/`. Teams source package versions differ from the 2.1.1 release/package identity; that publishing association limitation remains explicit. The complete grant for proxy-agent-negotiate1.1.0 and standardwebhooks1.1.1 MIT-package/Apache-root applicability remain unresolved. No blanket legal/distribution clearance, complete corresponding-source inventory or base/SDK vulnerability certification follows from this material. CBM static-runtime/AFM/private candidate distribution gates were not solved or bypassed by packaging; those artifacts are absent.

The application production npm audit returned zero reported vulnerabilities for the locked graph; that is scoped npm advisory evidence, not an OS/native/private artifact assessment. A fresh official Node check still found the October21 security preannouncement (highest HIGH, last updated Oct14) and 24.22.0 as the newest24.x entry. Specific new vulnerability paths could not be evaluated from that notice. No frozen runtime was silently upgraded; actual deployment requires another release/advisory applicability check. [Node announcement](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), [official distribution index](https://nodejs.org/dist/index.json)

## Verification record

The first five bootstrap behaviors passed after the missing composition and missing PSP binding were implemented. A test initially referenced the wrong PSP report property; that type error was corrected against the existing #27 contract and was not counted as a pass. The first container run failed in owned fixture setup when a root/CHOWN-only helper tried chmod on an already UID1000 volume. The harness now verifies actual private ownership without privileged repair. A subsequent driver close returned Node's unsettled-top-level-await exit13 despite a closed runtime; its terminal output/exit handling was corrected. No resource cap, assertion or deadline was weakened.

The actual image contracts exercise both reports, same-volume dedupe/budget/idempotent settlement, SIGKILL interruption, real SIGTERM closed versus five-second unknown, injected public-clock model timeout, startup/write/audit refusal, wrong owner/mode/read-only/missing volume, double-writer refusal, no replay and sanitized C/D/controlled-file output. They use the image's application/dependencies; only the technical driver is mounted read-only. No host application checkout replaces image code, and no Docker socket/controller was put inside it. Artifact contracts independently verify OCI/Docker content identity and negative inputs. The Python optimization test first reproduced a missing rejection; invariant checks now always execute rather than relying on removable asserts.

Final checks on the fixed Node24.22.0 toolchain:

- Project build/typecheck, Pi strict consumer positive/negative, Teams full-declaration positive/negative and signed local interop passed. The bootstrap/runtime source closure additionally passed `--skipLibCheck false`; the first manual invocation omitted TypeScript7's required `--ignoreConfig` and stopped with TS5112, then the corrected command passed. The inherited Pi vendor42 declaration limitation and narrow approved project `skipLibCheck:true` remain unchanged.
- All **415** portable behaviors passed on macOS arm64 and the original Linux arm64 network-none/read-only-root-and-checkout/512 MiB/pids64/64 MiB tmpfs profile, with concurrency2. macOS first returned414/415 for the existing Teams absolute pre-parse deadline observation; an isolated invocation also failed, and the subsequent unchanged full run passed415/415. Those failures remain recorded. Neither its100ms observation bound, virtual4999+1 advance nor production logic was changed; its client/server timer-registration ordering remains an existing timing limitation, not a proven production defect. Linux passed415/415 on its first run here.
- The exact runnable config above passed **6/6** container/OCI contracts at concurrency1, including both scenarios, physical storage/lock failures, interruption, closed/unknown/timeout, dedupe/fees, canaries and Python-optimization refusal. The fixed-source ignored-TS/stale-JS contract separately passed **1/1** against the actual image inventory. JavaScript/Python syntax and four-document placeholder YAML checks passed. The original empty working-tree `git diff --check` passed; it did not validate the implemented commit range. The separately executed `git diff --check 65508fd3e21ff35730ebe1593207ce3fa82286a9...f289e82c888d65597a7a30591c9c29bae215f9f8` exited **2**, reporting preserved CRLF and final blank-line bytes in `notices/bignumber.js-9.3.1.LICENSE.txt`. The same fixed-range command with `-- . ':!notices/*.txt'` exited **0** for the code/configuration and other documentation. Third-party notice bytes and their SHA256 remain verbatim; the full-range failure is not counted as a pass.
- The unchanged production lock's npm advisory audit returned zero reports. OS/native/private-source vulnerability review, notice applicability/source obligations and the pending Node advisory remain outside that scoped result. No actual CBM/private Kibana/model/Teams tenant/CPA/company/cloud/CSI/backup run was performed for this packaging ticket; earlier local protocol evidence is not reclassified as G2–G4 enablement.

Executed entrypoints (artifact variables name administrator-owned local evidence, with no fixture fallback):

```sh
npm run typecheck
npm run build
node scripts/check-pi-types.mjs
node scripts/check-teams-types.mjs
node scripts/check-teams-interop.mjs
node_modules/.bin/tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext \
  --moduleResolution NodeNext --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --skipLibCheck false --types node \
  src/bootstrap/runtime.ts src/bootstrap/main.ts
node --test --test-concurrency=2 dist/tests/behavior/*.test.js
docker run --rm --pull=never --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m --memory=512m --pids-limit=64 \
  --mount type=bind,source="$PWD",target=/app,readonly --workdir=/app \
  node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 \
  node --test --test-concurrency=2 dist/tests/behavior/*.test.js
BAU_CONTAINER_IMAGE=sha256:2a35913e6a20e99a1cd0b4bd2fe35488ed95fa1cad6640556c8bc1a200d8fe54 \
  BAU_OCI_LAYOUT=/absolute/local/oci node --test --test-concurrency=1 \
  dist/tests/contracts/container-runtime.test.js dist/tests/contracts/image-oci.test.js
BAU_IMAGE_INVENTORY=/absolute/local/inventory-exact.json \
  node --test tests/contracts/image-source.test.ts
```

The retained source6c7 build/save plus fixed conversion, independent exact-image inventory, source comparison and contract checks establish the local identities above. The full build/save wrapper was not rerun merely to regenerate the same large archive after host-only verification fixes. No remote registry manifest, image signature, Kubernetes pull/application or real readiness was verified. Mock G0 and local synthetic G1 are the completed scope; G2–G4 and their approvals/evidence remain missing, and #28 completion is not POC Go.
