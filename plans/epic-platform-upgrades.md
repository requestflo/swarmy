# Epic: Platform upgrades — one button, never rebuild a cluster

> Status: in progress. Phase 1 (Garage v2) is being built first because it is the
> hardest upgrade the platform has to perform and it forces the upgrade primitives.

## Problem

A swarmy cluster is ~8 moving parts — controller, agents, the Caddy edges,
swarmy-dns, Garage, the NetBird sidecar, registry, the observability stack — and
today none of them can be upgraded from the product except agents:

- The controller, Caddy, DNS and NetBird float on `:latest`. "Upgrading" means
  re-running the installer, and a node restart can silently pull a newer (or,
  before the images concurrency fix, OLDER) build. There is no notion of "the
  version this cluster runs".
- Garage (`v1.0.1`), the registry and ClickHouse/OTel are pinned in controller
  code. Bumping them needs a controller release AND someone to notice the running
  service didn't change.
- Some upgrades are not rolling: Garage v1→v2 stops every member at once and
  replaces the admin API wholesale.

Nobody should have to destroy a cluster to get a new version. Upgrading must be a
button: preflighted, backed up, ordered, health-gated, resumable across the
controller restarting itself, and rolled back on failure.

## Decisions (with the user, 2026-09-24)

- **Channels:** Stable (tagged releases, default) + opt-in Edge (every `main` build).
- **Policy:** nothing changes until an admin clicks Upgrade; opt-in auto-apply of
  PATCH releases (x.y.Z) inside a maintenance window.
- **Non-rolling steps (Garage major):** metadata snapshot + controller backup first,
  then a brief, announced pause (~1–2 min of object storage unavailable), rollback =
  restore the snapshot on the old image.

## Design

### 1. The platform manifest (the cluster's bill of materials)

CI emits `platform.json` for every build and bakes it into the controller image:

```json
{
  "version": "1.2.0", "channel": "stable", "commit": "…",
  "components": {
    "controller": { "image": "ghcr.io/requestflo/swarmy-controller", "digest": "sha256:…" },
    "agent":      { "image": "…/swarmy-agent", "digest": "…", "binaries": { "linux-x64": "sha256…", "linux-arm64": "…" } },
    "caddy":      { "image": "…/caddy-swarmy", "digest": "…" },
    "dns":        { "image": "…/swarmy-dns", "digest": "…" },
    "garage":     { "image": "dxflrs/garage", "tag": "v2.4.1", "digest": "…", "major": 2 },
    "netbird":    { "image": "netbirdio/netbird", "tag": "…", "digest": "…" },
    "registry": {…}, "otelCollector": {…}, "clickhouse": {…}
  },
  "migrations": [{ "id": "garage-v1-to-v2", "when": { "garage.major": { "lt": 2 } } }]
}
```

- Every system service is deployed **by digest from the manifest** — no floating
  tags in running services. The controller's own manifest is "what this cluster
  should run"; live service images vs manifest = drift (surfaced, and converged by
  the existing reconcile workers).
- **The BOM already exists** (self-reliance B3/B4, 2026-09-24):
  `packages/core/src/system-images.ts` lists every system image with its upstream
  index digest pinned (third-party) or floating (swarmy's own builds, until CI's
  `platform.json` fills them in). The `system-image-mirror` worker copies the BOM
  into the built-in `registry:2` (`swarmy-system/<host>/<path>`, digest-preserving
  `regctl image copy`) and records `swarmy.mirror.<key>=<ref>@<digest>` labels on
  the registry service; the hub dispatch decorator then deploys those services from
  the cluster by digest. `platform.json` should be GENERATED from that module (CI
  resolves the own-image digests and writes them back), not maintained twice.
- **Feed = a setting.** `SWARMY_PLATFORM_FEED_URL` (org/controller setting), default
  the GitHub Releases feed for the channel; an air-gapped estate points it at its own
  static mirror (any HTTPS URL serving `<channel>/platform.json` + `.sig`). Same
  shape as every other default external URL (self-reliance rule 4).
- **Signed with a swarmy release key, not Sigstore keyless.** CI signs
  `platform.json` with a cosign KEY PAIR (`cosign sign-blob --key`, tlog off — the
  same `--tlog-upload=false` / `--insecure-ignore-tlog` mode image signing already
  uses). The public key is baked into the controller image
  (`SWARMY_RELEASE_PUBKEY` overrides it for forks/self-builders). Verification is
  offline (`cosign verify-blob --key … --insecure-ignore-tlog`, in a runOnce like
  image verify), so no Fulcio/Rekor round-trip. A manifest that fails verification
  is never used — the Platform page shows "unverified release" and Upgrade stays
  disabled.
- **Offline bundles.** `swarmy-<ver>.tar` = `platform.json` + `.sig` + every BOM
  image as an OCI layout. `swarmy upgrade --bundle file.tar` (and
  `install-swarmy.sh --bundle`) verifies the signature, pushes the images into the
  built-in registry with the same `swarmy-system/…` paths + mirror labels, then runs
  the normal upgrade against that manifest. The pull-through cache and mirror mean a
  bundle is only needed when the cluster has no egress at all.

### 2. The upgrade run (resumable, like the mesh migration)

`PlatformUpgradeRun` (DB: status, from/to manifest, steps with per-step state) driven
by a worker that resumes after the controller restarts (it will — it upgrades itself):

1. **Preflight** — every node online, swarm quorum, disk headroom, target manifest
   verified, **controller self-backup** + **Garage metadata snapshot** taken.
2. **Controller** — `service update --image controller@digest`, stop-first (SQLite
   volume is node-pinned), Swarm `failure_action: rollback`; DB migrations run on boot
   (forward-only; the preflight backup is the downgrade path). The new controller
   resumes the run.
3. **Agents** — rolling, one node at a time, confirmed by the reconnect's build commit
   (`nodes.upgradeAgent`, already built).
4. **System services** in dependency order, each health-gated with auto-rollback of
   that component: Garage (rolling for minor/patch; the registered **migration** for a
   major) → swarmy-dns (rolling global) → Caddy edges (rolling; `stream_close_delay`
   keeps connections) → NetBird sidecars (per node; identity persists in its volume, so
   mesh IPs don't change) → registry / observability.
5. **Verify** — cluster health, a synthetic request through every edge, then mark the
   run done and audit it.

A failed step halts the run with a resumable state and a plain-words reason — never a
half-upgraded cluster with nobody told.

### 3. UI — Settings → Platform

- Current version + channel, per-component versions and drift.
- "vX available" with the changelog; **Upgrade** → preflight report (what will
  restart, any pauses like the Garage window) → confirm → live per-component progress.
- History of runs (audited). Toggle: auto-apply patch releases + maintenance window.

### 4. Installer

`--version`/`--channel` pin; a re-run converges to the chosen manifest (it already
converges; it just stops meaning "latest").

## Phases

1. **Garage v2** — v2 admin client (the v2 API is RPC-style `/v2/<Op>`; v1 is gone),
   v2 config for new clusters, and the in-place **v1→v2 migration** (snapshot → stop
   all members → start v2 → verify → rollback path) built as the first registered
   platform migration. Fixes S3 uploads from current AWS SDKs (unsigned-trailer +
   CRC64NVME checksums; v1.0.1 and v1.3.1 reject them, v2.4.1 accepts — verified).
2. **Manifest + pinning** — CI `platform.json`, digest-pinned system services, a
   read-only Platform page (versions + drift).
3. **Upgrade run + button** — the orchestrator, feed (URL setting) + release-key
   signature verification, channels, auto-patch, history, offline bundles.

When phase 3 lands, the hooks to add: `platformFeedUrl()` (env/setting → default
GitHub), `verifyPlatformManifest(json, sig, pubkey)` (pure input builder + runOnce
cosign verify-blob), and `loadBundle(tar)` → registry push + mirror labels.
