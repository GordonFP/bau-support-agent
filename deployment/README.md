# Local Mock artifact

Build with the frozen Node 24.22.0 toolchain and installed lock, from a clean commit:

```sh
node scripts/build-image.mjs /absolute/new-owned-artifact-directory
```

The result contains one Docker-save archive, verified local OCI layout, actual inventory and separate manifest/index/config/archive hashes. It is not uploaded or remotely pullable. `kubernetes.example.yaml` remains a placeholder, not an applied deployment or a claim that the local manifest exists at its image reference.

The builder archives one fixed Git commit into a new owned directory and compiles there with the fixed installed compiler. Only that fresh tree is Docker's context: ignored extra TypeScript and old host dist files cannot enter it. The actual image's application paths, byte counts and SHA256 must exactly match the fresh compilation before the build receives a verified receipt. Installed host compiler/declarations are tooling; Linux production dependencies still install separately from the archived lock with lifecycle scripts disabled.

The application entrypoint loads the bounded host JSON at `BAU_CONFIG` (default `/etc/bau/runtime.json`). Only schemaVersion1/profile mock/recordsDirectory are accepted. It opens the private persistent store and durable startup audit before reporting Mock ready, then waits for SIGTERM/SIGINT; it exposes no business network listener. Two-scenario checks call existing A–D from a host-mounted technical driver. Missing real credentials/approvals do not disable Mock; missing its required writable record store does. No anonymous fallback, automatic repair, backup or task/send recovery exists.

For local execution use the exact recorded Docker config ID with `--pull=never --init --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 512m --pids-limit 64 --tmpfs /tmp:rw,nosuid,nodev,size=64m` and an explicitly owned persistent volume at `/var/lib/bau/records`. A newly created local Docker volume inherits the image's UID1000/mode0700 mount point; verify the actual stat before use. Existing storage is never chowned or replaced by the app. Two writers on that tested volume are refused by the existing lifetime SQLite lock.

SIGTERM first closes admission, then waits original work. One cached five-second waiting boundary reports closed or unknown. An unknown result forces a separately identified local process exit; it does not prove external cancellation or release fees. Normal stop does not trigger retention deletion or reset budget/dedupe. A restart records interrupted work and never restores investigations/model calls/sends.

The Secret/volume/network references are placeholders for later G3 evidence, not self-attested verification or enabling switches. Real source snapshots must be read-only and separately scoped; records alone are writable. Model egress requires its own approved network and cost/output evidence. Index management stays outside this runtime, identity, image and credentials. Docker CLI/socket, native CBM/private Kibana artifacts, tests and evaluation administration are excluded. Unverified host backups/snapshots remain disabled, including automatic host copies. Actual encryption/keys/CSI/flush/expiry and real identity/resource/audience/model approvals are not established locally. Groups, CPA, company and real source routes stay closed.
