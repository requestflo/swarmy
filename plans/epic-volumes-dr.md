# Epic: Volume management + DR (replicated object store, backup/restore, restore-on-recovery)

> Status: plan / implementation-ready. Targets the existing swarmy scaffold (Bun + Turborepo, tRPC v11/Hono, Prisma 7/Postgres, agent dial-out WS, pluggable driver registries). Do not redesign the scaffold; this epic plugs into it.

## Problem

Docker Swarm has no good built-in answer for **stateful** workloads. A `local` volume is pinned to the node that first created it; if that node dies, the data is gone and the service either cannot reschedule or reschedules to a fresh empty volume. That directly breaks swarmy's promise ("anyone can just deploy") the moment someone runs Postgres, Redis, MinIO, a CMS, etc.

We need to solve three things at once, in priority order:

1. **Backup/restore of volumes** — scheduled, deduplicated, encrypted snapshots to S3 (cloud) or to another node over the mesh (off-cloud). This is the floor: even with no fancy storage, a user must never permanently lose data, and must be able to restore to any point.
2. **Restore-on-recovery / reconciliation** — when a node dies, a new node joins, or a user clicks "restore," the service and *its data* come back on a healthy node with minimal manual work and bounded downtime.
3. **Off-node primary storage (later)** — a self-hosted, S3-compatible object store **replicated across the swarm**, so volume data lives off any single node and *any* node can run the app. Plus a clustered block/file option (CSI) for apps that need a real POSIX volume.

Constraints from the project: must stay unopinionated (stacks run with or without swarmy), one-command/zero-config easy, org-scoped, fully audited, and pluggable (every capability individually disableable). DR must ride the existing dial-out mesh so it works behind NAT with no inbound ports.

Non-goals: synchronous multi-writer clustered databases (Galera/Patroni), block-level continuous replication (DRBD), and "zero RPO" guarantees. We target *low-ops, good-enough* DR for small/medium swarms (3–9 nodes), with a clean upgrade path to stronger storage.

## Recommended approach

Three layers, each independently adoptable. **Layer 1 (backup/restore) is the MVP and the foundation;** it works even with vanilla `local` volumes and is the only layer required to ship value.

### Layer 1 — Snapshot/backup tooling: **restic** (not kopia, not borg)

Pick **restic**, run as a short-lived container the agent launches (`restic/restic` image, or vendored static binary), targeting any S3-compatible bucket. Why restic over the alternatives:

- **Single static Go binary, no daemon, no server** — fits swarmy's "the agent applies generic intent" model perfectly. We invoke it per job and parse JSON output (`--json`). No long-running process to supervise, unlike a kopia repository server.
- **Encrypted + deduplicated + incremental** by default (content-defined chunking, AES-256, per-repo password). Encryption-at-source matters because the off-site target may be another user's node over the mesh — restic encrypts before it leaves the box, so the target never sees plaintext. This is the decisive property for "off-cloud via the mesh."
- **S3 is a first-class backend.** Same code path whether the target is AWS S3, Backblaze B2, Cloudflare R2, MinIO, or *swarmy's own Garage cluster* (Layer 3). One backend abstraction covers cloud + self-hosted + off-site.
- **Append-only / `forget`+`prune` retention policies** map cleanly to a "keep N daily / M weekly" UI knob.
- Mature, ubiquitous, trivially restorable by hand (`restic restore` works without swarmy installed — preserves the unopinionated promise: a user can recover even if swarmy is gone).

Why not **kopia**: kopia benchmarks slightly faster on backup and lighter on CPU/RAM, and has nicer built-in policy/GUI/multi-user — but those strengths overlap with things swarmy *already provides* (scheduling, multi-tenant UI, RBAC). Kopia's repository-server model and richer config surface is more moving parts for no net user benefit here. Why not **borg**: best restore speed and memory use, but no native S3 backend (needs rclone/borg-over-ssh shims), which kills the clean "any S3 target including over-mesh" story. restic is the best *fit*, even if not the single fastest.

**Consistency** is the real backup hazard (a live DB on disk = a torn snapshot). restic alone snapshots bytes, not transactions. We solve this with **per-volume pre/post hooks** declared on the backup job:
- Default (safe-ish): filesystem-only snapshot, fine for most app data and append-mostly workloads.
- `freeze` mode: `docker pause` the consuming container(s) for the snapshot window, then unpause (seconds of stall, crash-consistent).
- `command` mode: run a dump inside the container first (e.g. `pg_dump`, `mongodump`, `redis BGSAVE`) into a sidecar path, back *that* up. Shipped as opt-in recipes for the common engines; otherwise the user supplies the command. This keeps us unopinionated while giving good defaults.

### Layer 2 — Volume drivers: **vanilla `local` (default) + CSI cluster volumes (opt-in)**

- **Default: `local` driver, zero config.** Combined with Layer 1, this already gives "your data survives a node death" via restore. This is what 90% of users get with no decisions to make.
- **Opt-in: Docker Swarm CSI cluster volumes** (moby ≥ 23.0, `docker volume create --driver <csi> --type cluster`). Swarm natively reschedules a service to another node and the CSI controller re-publishes the volume there — *true* failover with no restore step. We expose this as a per-volume "clustered" toggle that emits the right CSI volume spec; the storage behind it is the user's choice of CSI plugin (Hetzner Cloud CSI, democratic-csi/NFS/ZFS, LizardFS, etc.). We do **not** write a CSI plugin; we orchestrate existing ones and own the UX/lifecycle.
  - Caveats we encode in the UI/validation: CSI plugin must be on all **manager** nodes; cluster volumes work only with Swarm *services* (not plain containers); no snapshot/clone/expand in the base Swarm CSI impl — so **Layer 1 backups still apply on top of CSI volumes** (CSI gives availability; restic gives point-in-time recovery + off-site). The two are complementary, not either/or.

### Layer 3 — Replicated object store: **Garage** (bundled, optional) for the off-node S3, with MinIO as the "bring-your-own / single-node" alt

For swarmy's *own* "S3-compatible store replicated across the swarm" we bundle and manage **Garage**:

- **Designed for exactly our topology**: geo-distributed nodes that are *not* in one datacenter, talking over a network that may be high-latency. This is the only one of the four built around "nodes spread out + off-site," which is the whole point of "DR ties into the mesh / off-site target."
- **Replication (configurable factor, typically 3x), not erasure coding** — simpler failure model, any single node loss is non-events, fits small clusters. We accept the storage overhead in exchange for low ops.
- **Single static Rust binary, tiny RAM/CPU footprint, no external metadata DB** (embedded). Deployable as a Swarm `global`/replicated service the agent stands up. Closest to "zero-config" of the replicated options.
- **S3 API is "essential operations" complete** — exactly what restic needs (PUT/GET/list/multipart). restic + Garage is a known-good pairing. We don't need lifecycle policies from the store (restic owns retention).

Why not **MinIO** as the bundled cluster: erasure coding gives better storage efficiency, but its distributed mode wants same-DC low-latency nodes and a fixed even server/drive layout — awkward for an organically-grown, geo-spread swarm, and recent licensing/feature churn makes bundling it risky. We still **support MinIO as an external/BYO target** (it's just an S3 endpoint) and as a fine **single-node** local store. Why not **Ceph**: gold standard at scale, but heavyweight (MON/OSD/MGR daemons, real operational burden) — violates one-command/zero-config for our audience. Why not **SeaweedFS**: strong and lightweight, best k8s integration — but its master/volume/filer split is more components than Garage, and its sweet spot is single-DC scale-out rather than geo-redundancy. Offer SeaweedFS later as an additional driver if demand appears.

**Key architectural decision:** Layer 3 is *also just an S3 backup target* from Layer 1's perspective. So the object store and the backup system share one abstraction (`BackupTarget`). "Replicate volumes off-node" = "back up to the in-swarm Garage cluster"; "off-site DR" = "back up (or `restic copy`) to a second target that lives on a remote node / cloud." This collapses three features into one mechanism with different targets.

## Architecture & integration

Everything below mirrors existing swarmy patterns: a **pluggable driver registry** (like `@swarmy/ingress`) renders **generic intent** that the agent applies via **new wire-protocol command types**; tRPC routers + a services layer drive it; a **worker scheduler** in `apps/api` (like `metrics-sampler`/`retention`) fires jobs; everything is org-scoped and audited.

### New package: `@swarmy/storage`

Parallels `@swarmy/ingress`. Pure, no IO — produces specs/intent the agent executes.

- `BackupDriver` registry (`restic` first; room for `kopia` later) — `render(job) -> RenderedBackupPlan`, `parseResult(raw) -> SnapshotResult`, retention → `forget`/`prune` args.
- `StorageDriver` registry for Layer 3 object store (`garage`, `minio`, plus `none`) — `render(config) -> RenderedStoreDeployment` (a Swarm service spec + config files), `joinPeers()`, `status()`.
- `VolumeProvisioner` helpers for Layer 2 — translate a "clustered volume" request into the right Docker volume create spec (`local` vs CSI cluster type/AccessMode/topology).
- Shared Zod types re-exported from `@swarmy/core` so agent + controller share one definition (same convention as `RenderedConfig`).

### Wire protocol — new message types (`packages/core/src/protocol/`)

New file `protocol/backup.ts`, registered in `messages.ts` discriminated unions. Each carries the standard `{ commandId, timeoutMs? }` preamble and returns existing `commandResult` / `logChunk` frames (so progress streams through the *existing* correlation + subscription plumbing — no transport changes).

Controller → agent commands:
- `runBackup` — `{ commandId, jobId, repo: ResticRepoRef, volumes: string[], hooks: BackupHook[], tags: string[], retention?: RetentionPolicy }`. Agent: optional pre-hook (pause/dump), mount volumes read-only into a restic container, `restic backup --json`, post-hook (unpause), report a `SnapshotResult` (snapshotId, bytesAdded, filesNew, durationMs) via `commandResult`; stream progress lines via `logChunk`.
- `runRestore` — `{ commandId, repo, snapshotId | "latest", targetVolume, include?: string[], conflict: 'overwrite'|'into-new' }`. Agent restores into a (possibly freshly created) volume; reports bytes/files restored.
- `pruneRepo` — `{ commandId, repo, retention }` → `restic forget --prune`.
- `checkRepo` — `{ commandId, repo, readData?: boolean }` → `restic check` (integrity / unlock).
- `applyStorageNode` — `{ commandId, rendered: RenderedStoreDeployment }` — bring up/configure the Garage (or MinIO) member on this node: write config files + deploy/update the Swarm service + run the join/layout-apply admin call. Mirrors `applyIngress` exactly.
- `provisionVolume` / `removeVolume` — `{ commandId, spec: VolumeSpec }` — create a `local` or CSI cluster volume per the provisioner.

Agent → controller (new): `snapshotResult` (or reuse `commandResult.result` payload — prefer reusing to avoid union bloat), and a periodic `storageState` heartbeat extension reporting repo sizes / store health (folded into the existing `heartbeat`/`metrics` snapshot rather than a brand-new top-level message).

`ResticRepoRef` = `{ targetId, kind: 's3', endpoint, bucket, prefix, region }` + credentials delivered **separately and just-in-time** (see Risks). Repo password (restic encryption key) is generated per target by the controller, stored encrypted, and injected into the command env — never written to disk on the node.

### DB models (`packages/db/prisma/schema.prisma`)

All org-scoped (FK to `Organization`, cascade), following existing cuid id + timestamp conventions. New enums: `BackupTargetKind { S3 GARAGE MINIO MESH_NODE }`, `BackupJobStatus { ACTIVE PAUSED }`, `SnapshotStatus { RUNNING SUCCEEDED FAILED PRUNED }`, `RestoreStatus { QUEUED RUNNING SUCCEEDED FAILED }`, `StorageClusterDriver { GARAGE MINIO NONE }`, `VolumeMode { LOCAL CLUSTER }`.

- **`BackupTarget`** — `{ id, orgId, name, kind, endpoint, bucket, prefix, region, credentialRef (encrypted, see below), resticPasswordRef (encrypted), meshNodeId? (when kind=MESH_NODE), enabled, createdAt }`. The single S3-shaped abstraction shared by cloud, MinIO, Garage, and over-mesh targets.
- **`BackupJob`** — `{ id, orgId, name, targetId, serviceId?, stackId?, volumeSelectors Json, schedule (cron string), hooks Json (BackupHook[]), retention Json, status, lastRunAt, nextRunAt, paused }`. The scheduler reads `nextRunAt`.
- **`Snapshot`** — `{ id, orgId, jobId?, targetId, serviceId?, resticSnapshotId, volumes Json, status, sizeBytes, filesNew, durationMs, hostNodeId, startedAt, finishedAt, error? }`. The restore catalog + history.
- **`RestoreOperation`** — `{ id, orgId, snapshotId, targetVolume, targetNodeId, conflict, status, bytesRestored, startedAt, finishedAt, triggeredById, reason (manual|node-recovery|new-node|reconcile) }`. Drives the reconciliation flow and audit.
- **`StorageCluster`** — `{ id, orgId @unique, driver, enabled, replicationFactor, memberNodeIds Json, layout Json, accessKeyRef, secretKeyRef, settings Json }`. The Layer-3 object store config (one per org), analogous to `IngressConfig`.
- Extend **`Service`**: add `volumeMode VolumeMode @default(LOCAL)` and a `volumes` shape that records driver + clustered flag (the column already exists as `Json`; just enrich the encoded type — no migration of meaning, additive).

### Credential handling

Reuse the established pattern of "hash/secret refs, never plaintext at rest" from `JoinToken`/`Node.sessionSecretHash`. Object-store and S3 creds + restic passwords are encrypted at the controller with a server key (`SWARMY_SECRET_KEY`, new env, AES-GCM) and stored as `*Ref` ciphertext columns; decrypted only in-memory when building a command, delivered to the agent over the already-authenticated WS, used as process env for the restic container, never persisted node-side. Add an env var + a `core` `secrets.ts` helper.

### Controller: tRPC routers + services + scheduler

New routers under `packages/trpc/src/routers/`: `backups.ts` (targets CRUD + `testTarget`, jobs CRUD, `runNow`, list/get snapshots, `pruneNow`, `checkNow`), `restores.ts` (`createRestore`, list/get, `restoreLatestForService`), `storage.ts` (Layer-3 cluster: `getConfig`, `setDriver`, `enable`, `addMember`, `removeMember`, `status`, `previewDeployment` — mirrors `ingress.ts` 1:1). New services in `services/`: `backup.service.ts`, `restore.service.ts`, `storage.service.ts`, plus `reconcile.service.ts`. Reads (snapshot lists, cluster health) come from DB + the hub's in-memory snapshot store; writes/lifecycle go through `ctx.hub.dispatch(nodeId, cmd, payload)` using `resolveManagerNode`/`requireOnlineNode` from the existing `dispatch.service.ts`. Add the new `CommandName`s (`backup.run`, `backup.restore`, `backup.prune`, `backup.check`, `storage.apply`, `volume.provision`) to `hub/types.ts` and their protocol-type mapping.

New worker `apps/api/src/workers/backup-scheduler.ts` (registered in `workers/index.ts` next to `metrics-sampler`/`retention`): every minute, find `BackupJob`s with `nextRunAt <= now` and `!paused`, pick a node that hosts the volume (or any online manager for cluster/CSI volumes), dispatch `runBackup`, then advance `nextRunAt` from the cron. A second concern, **DR reconciliation**, lives in `reconcile.service.ts` and is triggered by gateway events (node OFFLINE past a grace window, new node ONLINE) and by Swarm convergence failures: it queries which services are stuck for want of data and enqueues `RestoreOperation`s of the latest snapshot onto a healthy node before/while the service is rescheduled. This reuses the existing node-status/heartbeat signals from `apps/api/src/gateway`.

### Agent capabilities (`apps/agent/src/`)

New `apps/agent/src/backup.ts` invoked from `executor.ts` for the new command types. The agent already has dockerode (`@swarmy/core/docker`) and `Bun.spawn` (used by ingress `execShell`). It will: run hooks (`docker pause`/dump-exec via dockerode), launch the restic container with volumes mounted (or spawn the vendored binary), stream `--json` progress as `logChunk`, return structured results. Bundle/pull a pinned `restic` image; cache the binary. The agent stays generic — adding kopia later or a new store driver is a new render type, not an agent rewrite (the whole point of the architecture).

### UI surfaces (`apps/app`)

- **Service detail → "Data" tab**: volume list with mode badge (`local`/`clustered`), "Back up now," last snapshot, restore picker (point-in-time list), "Restore latest." One-click "Protect this service" creates a sensible default job.
- **Org → Backups**: targets (add S3/Backblaze/R2/MinIO/Garage with a `testTarget` button), jobs (cron picker, retention sliders "keep 7 daily / 4 weekly"), snapshot history + sizes, restore queue.
- **Org → Storage (advanced, off by default)**: enable replicated object store, choose driver (Garage/MinIO), pick member nodes, see replication health/layout, preview deployment (mirrors the ingress `previewConfig` UX).
- **Settings → DR**: off-site target selection, RPO/RTO display per service, "test restore" (restore to a throwaway volume + checksum) to prove backups are real.

## MVP vs later

**MVP (Phase 1 — backup/restore on vanilla `local`):** `@swarmy/storage` with the restic `BackupDriver`; `BackupTarget`/`BackupJob`/`Snapshot`/`RestoreOperation` models; `runBackup`/`runRestore`/`pruneRepo`/`checkRepo` protocol + agent impl with pause/dump hooks; `backups`/`restores` tRPC routers; `backup-scheduler` worker; Service "Data" tab + Backups page; cloud S3 + MinIO/R2/B2 as targets; encrypted creds. This alone delivers "never lose your data, restore to any node." **Ship this first.**

**Phase 2 — restore-on-recovery + over-mesh off-site:** `reconcile.service.ts` (auto-restore on node death / new node), `MESH_NODE` target kind (restic to another node's local disk over the existing WS-tunneled path / agent-served endpoint), `restore-latest-for-service`, "test restore," RPO/RTO surfacing. Makes DR automatic, not manual.

**Phase 3 — CSI cluster volumes:** `VolumeMode.CLUSTER`, `provisionVolume`, CSI volume specs, UI toggle + validation (manager-only plugin checks). True live failover for apps that want it; backups still layer on top.

**Phase 4 — bundled replicated object store:** Garage `StorageDriver`, `StorageCluster` model, `applyStorageNode`, Storage page. Now "any node can run the app" because volumes back to an in-swarm replicated store. MinIO BYO/single-node and `restic copy` target-to-target (cheap off-site) round it out.

## Dependencies

- **On the node-lifecycle epic** (join/recovery): reconciliation hooks off node ONLINE/OFFLINE transitions and the "new node joined" event from the gateway/registry; needs a defined grace window before declaring a node dead.
- **On the scheduling/deployment epic**: restore-then-reschedule ordering — the deployment service must let reconcile place data before (or atomically with) re-converging a service, and CSI volume specs flow through the same deploy path.
- **On the mesh/networking epic**: the `MESH_NODE` (off-site) target needs a node-to-node data path. Cheapest: agent exposes a scoped, authenticated restic-rest/S3 shim reachable via the controller-brokered connection; otherwise depends on whatever overlay the mesh epic provides. This is the main cross-epic unknown.
- **Infra**: a pinned `restic` (and later `garage`/`minio`) image or vendored binary in the agent image; new env `SWARMY_SECRET_KEY` (controller crypto) and per-org generated restic passwords; Prisma migration for the new models.
- **No new transport**: rides the existing dial-out WS, command correlation, and `logChunk` streaming — zero gateway changes.

## Risks & open questions

- **Backup consistency for databases** is the sharpest edge. Filesystem snapshots of a live DB can be torn. Mitigation: ship engine recipes (pause vs dump) and default DB-detected services to a safe mode; surface a "consistency: crash-consistent / app-consistent" badge so users aren't misled. Open: how aggressively to auto-detect engines vs require explicit hook config.
- **Over-mesh off-site target** is the biggest design unknown and is why it's Phase 2, gated on the mesh epic. Need to decide the data path (restic-rest server per node, brokered TCP, or overlay) and quota/abuse controls (a node hosting another org's encrypted blobs).
- **Restore vs reschedule race**: Swarm may reschedule a stateful service to an empty volume before reconcile restores. Mitigation: provision the target volume + restore *first*, then release the service to that node (constraint pinning), or use a "data not ready" readiness gate. Needs tight coupling with the scheduling epic.
- **RPO/RTO honesty**: with scheduled restic, RPO = backup interval (minutes–hours), RTO = restore time (size-dependent). CSI volumes get near-zero RPO/RTO for node failure but nothing for corruption/ransomware (still need restic). We must show *both* numbers per service and not over-promise "HA." CSI = availability; restic = recoverability; Garage = off-node durability — three different guarantees, communicated distinctly.
- **Key management**: lose the restic password and the backups are unreadable (by design). We must back up the keys themselves (escrow encrypted with the org/controller key) and warn loudly. Open: optional user-held passphrase for zero-knowledge mode (stronger, but support burden).
- **CSI fragmentation**: many plugins are k8s-flavored and don't work on Swarm; we should ship a short validated-plugins allowlist rather than claim universal support.
- **Garage version/API churn** and its weaker S3 completeness vs MinIO — fine for restic, but verify multipart + the exact admin API for layout before committing the bundled driver.

## Simplicity note

The whole epic stays one-command/zero-config because of one decision: **the default path requires zero choices.** New users get `local` volumes (no driver to pick) and, on first deploy of anything with a volume, a one-click "Protect this data" that creates a daily restic job to swarmy's managed/default target with sane retention — encrypted, deduplicated, automatic. They never see the word "restic," a cron expression, or an S3 endpoint unless they open advanced settings.

CSI, the bundled Garage cluster, and off-site mesh targets are all **opt-in toggles, off by default**, each individually disableable — exactly the project's "pluggable, individually disableable" principle. Because backup, off-node storage, and off-site DR all collapse onto the single `BackupTarget` S3 abstraction, there's *one* mental model ("pick where data goes") instead of three subsystems. And because restic is a plain binary writing a standard repo, a user can recover their data by hand with or without swarmy running — the unopinionated promise holds all the way down to disaster recovery.
