# Epic: volume mobility — add a disk, move a volume, retire a server

Status: **design, 2026-09-24.** Built so far (pure, unit-tested): phase 3's
planner (`packages/trpc/src/services/node-decommission.plan.ts`), phase 5's
forecast (`packages/core/src/disk-forecast.ts`) and phase 1's disk
classifier + format gate (`packages/core/src/disk-inventory.ts`). No runner,
agent command or UI yet.
Owning skills: `managed-data-services` (Postgres/cache/search/vector, Garage,
`volume.list`), `backups-dr` (restic, dr-reconcile, drills),
`docker-native-storage` (where state lives), `reconcile-workers` (the runner),
`agent-handlers` (new agent commands), `mesh-networking` (peer removal),
`geo-edge-routing` (edge handover). The controller store is SQLite now; no
Postgres-only features anywhere in this epic, and **no new Prisma model**: run
state comes from audit rows and labels (see §9).

The owner's question: *"What if they run out of disk? Can swarmy move data to
a new drive, or off a whole node, without it being the nightmare it is in
Kubernetes and Swarm? Protect the data and spread it around. I'm not sure how
to do it with a live database."*

---

## 0. The recommendation (short)

1. **Don't add a replicated volume layer.** On 1 GB servers nothing
   trustworthy fits: Ceph wants 4 GB per OSD, Longhorn is Kubernetes-only,
   GlusterFS has no corporate maintainer left, and Swarm CSI is still an
   "initial implementation" with a history of regressions. Every option trades
   a problem you can see (a volume lives on one server) for one you can't (a
   distributed filesystem with split-brain on a 1 GB box).
2. **Make data mobile instead.** Swarmy already knows where every stateful
   thing lives (pin labels, container mounts, `Snapshot.hostNodeId`). Move each
   kind the way its own engine wants to move: databases **replicate, then
   switch over** (seconds of pause); plain volumes use a **two-pass rsync**
   (about a minute of pause); object storage uses **Garage's own layout change**.
3. **Protect with copies you already have:** a standby on a second server by
   default for new managed databases (when there are 2+ servers), restic to
   Garage on by default, and Garage replication across servers.
4. **Retire a server is one button**: a plan you can read, then run step by
   step. That is the headline feature, and it is the one Kubernetes and Swarm
   users actually struggle with.
5. **Disk-full is predicted, not discovered**: a forecast from the samples we
   already store, and alerts that say "add a disk" or "move X to Y".

---

## 1. Facts, checked 2026-09-24

### 1.1 Swarm volumes

| Fact | Source |
|---|---|
| A `local` volume exists only on the node that created it. When a task reschedules, Docker makes a **new, empty** volume of the same name on the new node. This is the bug `data-pin.ts` exists to prevent. | [Docker volumes docs](https://docs.docker.com/engine/storage/volumes/) and our `packages/core/src/data-pin.ts` |
| Swarm **cluster volumes (CSI)** arrived in Engine 23 (Feb 2023). The moby doc still calls it an initial implementation: **no snapshots, no cloning, no volume expansion**, plugins must be installed by hand on every node. Availability modes `active` / `pause` / `drain` exist. | [moby docs/cluster_volumes.md](https://github.com/moby/moby/blob/master/docs/cluster_volumes.md) |
| CSI in Swarm was **broken from 26.0.3 until 28.2.0** (moby#47974, fixed by moby#49961 in 28.2.0). Swarmkit also reads the CSI spec differently from other orchestrators (moby#49780). | [moby#47974](https://github.com/moby/moby/issues/47974), [v28.2.0 release](https://github.com/moby/moby/releases/tag/v28.2.0), [moby#49780](https://github.com/moby/moby/issues/49780), [Flo's write-up, Dec 2024](https://forestier.re/en/posts/2024-12-23-docker-swarm-csi/) |
| Plugins that work in Swarm: **Hetzner** csi-driver (Swarm support is "not officially supported", **beta**, scope `single` only, **no resize**, a volume attaches to one server), plus AWS EBS and DigitalOcean community builds, democratic-csi (NFS/iSCSI/ZFS), and NFS/SMB/SeaweedFS CSI in community repos. Ceph-CSI has no Swarm packaging (ceph-csi#3769). | [Hetzner Swarm README](https://github.com/hetznercloud/csi-driver/blob/main/docs/docker-swarm/README.md), [ceph-csi#3769](https://github.com/ceph/ceph-csi/issues/3769) |
| Verdict: CSI is useful for **one** thing on a cloud: a provider block volume that detaches from a dead server and attaches to a live one. Swarmy already registers against an existing CSI driver (`clusterVolume.service.ts`) and should keep that as an expert option, not a default. | — |

### 1.2 Growing a disk on the same server

| Fact | Source |
|---|---|
| **DigitalOcean Volumes** grow online in the control panel/API; then `resize2fs` (ext4) or `xfs_growfs` (XFS) grows the filesystem while mounted. Shrinking is not possible. | [DO: increase volume size](https://docs.digitalocean.com/products/volumes/how-to/increase-size/), [DO: expand partitions](https://docs.digitalocean.com/products/volumes/how-to/expand-partitions/) |
| **Hetzner Cloud Volumes** grow online up to 10 TB, never shrink; then `resize2fs` on the server. | [Hetzner community: resize](https://community.hetzner.com/tutorials/resize-ext-partition/) |
| **AWS EBS Elastic Volumes** grow online on Nitro instances (`modify-volume`); then `growpart` (if partitioned) and `resize2fs`/`xfs_growfs`. **One modification per volume per 6 hours.** | [AWS: extend the file system](https://docs.aws.amazon.com/ebs/latest/userguide/recognize-expanded-volume-linux.html) |
| A server's **root disk** usually grows only with a plan resize and a power-off (Hetzner "rescale", DO "resize droplet"), so the reliable no-downtime path is **an added block volume**, not a bigger root disk. | provider docs above |
| The `local` driver can put a named volume anywhere: `docker volume create -d local -o type=none -o o=bind -o device=/mnt/data1/<name> <name>`. The volume keeps its name, so a service spec does not change — only the volume's backing path. | [Docker volumes docs, "local driver options"](https://docs.docker.com/engine/storage/volumes/#create-a-volume-using-a-volume-driver) |
| Moving all of `/var/lib/docker` (`data-root` in `daemon.json`) needs a Docker restart, which restarts every container on the server and briefly drops the node from swarm. **Per-volume placement is strictly better** for us. | [dockerd data-root](https://docs.docker.com/reference/cli/dockerd/) |
| LVM (`pvcreate` + `vgextend` + `lvextend -r`) grows one filesystem across several disks online, but it joins the disks' fates: lose one disk, lose the filesystem. Only worth it if the owner wants "one big disk". | [lvextend(8)](https://man7.org/linux/man-pages/man8/lvextend.8.html) |

### 1.3 Replicated storage for 1 GB servers — verdicts

| Option | Footprint / status | Verdict |
|---|---|---|
| **Longhorn** | Kubernetes-only (a CRD operator). | Not available. |
| **Ceph** | `osd_memory_target` defaults to **4 GiB**; under 2 GB is "not recommended", with "extremely slow performance". Plus MONs and MGRs. | Too heavy by 4–8×. No. |
| **GlusterFS** | Red Hat Gluster Storage ended at the end of 2024 and Red Hat disbanded the team. 31 commits in 2024. TrueNAS removed it; Fedora debated retiring it. | Life support. No. |
| **DRBD 9 / LINSTOR** | Mature block replication (kernel module), and LINBIT ships a Docker volume plugin with a Swarm guide. It needs the DRBD kernel module on every host (DKMS on cloud kernels), a LINSTOR controller (Java), and quorum or fencing to avoid split-brain. | Technically the best fit for "replicated volume", but the heaviest to operate. **Not by default.** Maybe later as an expert driver. |
| **SeaweedFS** | Tiny: master < 50 MB; volume server ~16–24 bytes of RAM per file. It has a CSI driver and a FUSE mount. | Good as object/file storage. As a POSIX volume for **databases** it is a FUSE filesystem: fsync semantics and latency make it wrong for Postgres. We already have Garage for objects. No. |
| **JuiceFS on Garage** | POSIX on S3 + a metadata engine (~300 B/file in Redis, ~600 B/file in SQL; SQLite is single-host only). There is a Docker volume plugin. | Good for shared, mostly-read files (uploads, media). Wrong for databases (FUSE, network write path). **Maybe later**: a "shared files" volume type backed by Garage. |
| **ZFS send/recv** | Incremental block-level snapshots; exactly right for moving volumes fast. It needs ZFS on the host, which cloud images don't have. | Use it if the host already has ZFS (detect `zfs` on the volume's mount). Not a requirement. |
| **rsync (two-pass)** | Everywhere; no daemon. | **Default** mover for plain volumes. |
| **restic → Garage** (already built) | Deduplicated, encrypted, already on by default for databases. | **Default protection**; a restore is also a slow move for an offline server. |

Sources: [Longhorn docs](https://longhorn.io/docs/), [Ceph hardware recommendations](https://docs.ceph.com/en/latest/start/hardware-recommendations/), [Phoronix: Fedora and GlusterFS](https://www.phoronix.com/news/Fedora-Maybe-Retire-GlusterFS), [gluster discussion #4324](https://github.com/gluster/glusterfs/discussions/4324), [LINBIT: Swarm with LINBIT SDS](https://linbit.com/blog/create-a-docker-swarm-with-volume-replication-using-linbit-sds/), [linstor-docker-volume](https://github.com/LINBIT/linstor-docker-volume), [SeaweedFS optimization wiki](https://github.com/seaweedfs/seaweedfs/wiki/Optimization), [JuiceFS metadata engines](https://juicefs.com/docs/community/databases_for_metadata/), [JuiceFS on Docker](https://juicefs.com/docs/community/juicefs_on_docker/).

### 1.4 Moving a live database

| Engine | How it moves with near-zero downtime | Source |
|---|---|---|
| **Postgres** | Add a streaming standby on the target (`pg_basebackup`), wait until replay LSN = primary flush LSN, stop writes, `SELECT pg_promote()`, repoint. The old primary rejoins with `pg_rewind` or a re-clone. **We already have all of this**: `decideFailover`, `pg_promote`, the `SWARMY_PG_REJOIN` epoch, and PGDATA moved aside, never deleted. | [pg_promote](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-RECOVERY-CONTROL), [pg_rewind](https://www.postgresql.org/docs/17/app-pgrewind.html) |
| **MySQL / MariaDB** | Clone plugin (`CLONE INSTANCE FROM`) or a dump for the replica, then GTID replication; switch with `read_only` on the old one and `STOP REPLICA; RESET REPLICA ALL` on the new one. | [MySQL clone plugin](https://dev.mysql.com/doc/refman/8.4/en/clone-plugin.html) |
| **MongoDB** | `rs.add()` a member on the target (initial sync, STARTUP2 → SECONDARY), then `rs.stepDown()` on the primary, then `rs.remove()` the old member. | [rs.stepDown](https://www.mongodb.com/docs/manual/reference/method/rs.stepDown/) |
| **Redis / Valkey** | `REPLICAOF` on the target, then **`FAILOVER TO host port`** (6.2+): it pauses clients until the replica has the full offset, then swaps roles. | [FAILOVER](https://redis.io/docs/latest/commands/failover/) |
| **Anything else** (a volume) | Two-pass rsync: a live pass (most of the bytes), scale the service to 0, a final pass (only the changes, usually seconds), verify, start on the target. A database copied this way is consistent because the final pass runs **stopped**. | — |

For **compose databases** (not managed by swarmy), phase 2 uses the two-pass
copy. Engine-aware replica moves for compose MySQL/Mongo are phase 2b, and only
if users ask: those databases are the user's config, not ours.

### 1.5 Garage, swarm membership, disk-full

| Fact | Source |
|---|---|
| Garage removes a node with `garage layout remove <id>` + `layout apply` (**one** apply, after every assign/remove). It re-replicates on its own. The node must stay up until resync finishes, or copies drop to (rf − 1). | [Garage layout](https://garagehq.deuxfleurs.fr/documentation/operations/layout/), [Recovering](https://garagehq.deuxfleurs.fr/documentation/operations/recovering/) |
| A swarm manager is removed by demote → `swarm leave` → `node rm`. Quorum needs a majority of managers; an even count tolerates no more failures than one fewer. | [docker node demote](https://docs.docker.com/reference/cli/docker/node/demote/), [docker swarm leave](https://docs.docker.com/reference/cli/docker/swarm/leave/), [Swarm admin guide](https://docs.docker.com/engine/swarm/admin_guide/) |
| `availability=drain` reschedules stateless tasks; `pause` stops new placements but leaves running tasks. **Pause first**, so data services keep serving while they move. | [Drain a node](https://docs.docker.com/engine/swarm/swarm-tutorial/drain-node/) |
| A full disk makes Postgres **PANIC** on WAL write and refuse to start until space is freed. Docker cannot pull images or start containers. Linear extrapolation (Prometheus `predict_linear`) is the standard forecast. | [Postgres: disk full](https://www.postgresql.org/docs/current/disk-full.html), [predict_linear](https://prometheus.io/docs/prometheus/latest/querying/functions/#predict_linear) |

### 1.6 What swarmy already has (reused, not rebuilt)

| Piece | Where | Reused by |
|---|---|---|
| Data pins (`swarmy.{db,cache,search,vector}.node` + `node.id==`) | `packages/core/src/data-pin.ts`, `manageddb-storage.ts` | Phases 2 and 3 — a move is "copy, then rewrite the pin" |
| Container mounts per node (`ContainerInfo.mounts`) | `protocol/containers.ts`, hub `latestContainers` | Phase 3 inventory (what data is physically here) |
| Standby + failover + rejoin | `manageddb-failover.ts`, `manageddb-reconcile.ts`, `manageddb-pg.ts` | Phase 2 Postgres move |
| restic to Garage, default-on DB backups, `Snapshot.hostNodeId` | `backups.service.ts`, `autoBackup*.ts`, `dr-reconcile.ts` | Safety backup before every move; restore path for offline servers |
| `volume.list` | agent `handlers/storage.ts` | Volume drivers (local vs CSI) on the target |
| statfs disk sampling → hub + `MetricSample.diskUsed/TotalBytes` in telemetry.db | `apps/agent/src/stats.ts`, `metrics-sampler.ts` | Phase 5 forecast; destination room checks |
| node-hygiene (prune at 85%) | `node-hygiene.core.ts` | Phase 5 — first reclaim, then suggest a move |
| `node.drain`, `node.remove`, `removeNodeBlockReason` | `node.service.ts` | Phase 3 steps |
| mesh-migration planner/runner (the pattern: pure plan + resumable runner) | `mesh-migration.plan.ts`, `mesh-migration.service.ts` | Phase 3 runner shape |

---

## 2. Phase 1 — "Add a disk"

**Goal:** the owner attaches a volume in the cloud console. Swarmy notices,
asks once, formats and mounts it, and new data goes there.

**Detection (agent).** New agent command `disk.list` → `lsblk -J -b -o
NAME,PATH,SIZE,TYPE,FSTYPE,MOUNTPOINTS,SERIAL,MODEL,RO,RM,PTTYPE` plus
`blkid -p` for the chosen device. A pure classifier in `@swarmy/core`
(`disk-inventory.ts`, **built**: `parseLsblk`, `classifyDisks`, `formatGate`,
`growableBytes`) turns it into one of:

| State | Rule | Offered action |
|---|---|---|
| `blank` | a whole disk, no partitions, no FS signature, no PT, not mounted, not RO, not removable, ≥ 1 GiB | **Format and use** |
| `has-data` | any FS signature or partition table | **Mount as-is** (read-only look first) — never format |
| `mounted` / `system` | mounted, or holds `/`, `/boot`, swap, or `/var/lib/docker` | nothing |
| `in-use-by-swarmy` | mounted under `/mnt/swarmy/<id>` | show usage |

**Safety rules (hard, in the agent, not only the UI):**
- The agent refuses `disk.format` unless the device is `blank` **at the moment
  of formatting** (re-probe with `blkid -p` + `wipefs -n`; any signature ⇒
  refuse). The controller sends the device **serial**, not only `/dev/sdb`
  (names reorder after reboots); a mismatch ⇒ refuse.
- The user types the last 4 characters of the serial to confirm (the pattern
  other destructive gates use). ABAC action `node.disk.format`, admin only,
  audited.
- ext4 by default (`mkfs.ext4 -L swarmy-<id> -m 1`). XFS as an expert option.
- Mount by **UUID** in `/etc/fstab` with `nofail,x-systemd.device-timeout=10s`
  so a missing disk never blocks boot. The mountpoint is `/mnt/swarmy/<fs-uuid>`.
- The container agent needs the host's `/dev` and `/etc/fstab`; it runs these
  as a privileged one-shot (`container.runOnce` with `--privileged -v
  /:/host`), the same way the mesh sidecar is privileged. The systemd agent
  runs them directly.

**Placement.** The disk becomes a **node label** `swarmy.disk.<uuid>=<mount>`
plus `swarmy.disk.default=<uuid>` (Docker truth; no table). New volumes that
swarmy creates on that node (managed DB data, blueprint volumes) are created
with `-o type=none -o o=bind -o device=/mnt/swarmy/<uuid>/volumes/<name>`.
The volume name does not change, so no service spec changes.

**Existing volumes** move with phase 2's *disk-to-disk* path (same node): stop,
rsync, recreate the volume with the bind device, start. For a managed Postgres
primary with a replica, the zero-pause version is "switch over to the replica,
recreate the old primary's volume on the new disk, let it re-clone, switch
back" — optional, because the stop-copy is usually under a minute.

**Online growth of an existing added disk** (the owner grew it in the cloud
console): the agent sees `lsblk SIZE` > filesystem size and offers **Grow**
(`resize2fs` / `xfs_growfs`, both online). No confirmation beyond one click:
growing cannot destroy data.

**Effort:** M (≈ 4–5 days): protocol + agent handler + classifier + tests
(1.5 d), label placement in the volume create paths (1 d), UI (1.5 d), e2e on
Lima VMs with a second virtual disk (1 d).

---

## 3. Phase 2 — "Move a volume"

One service, `volumeMove.service.ts`, and one pure strategy chooser
`chooseMoveStrategy(subject)`:

| Subject | Strategy | Pause | Verify |
|---|---|---|---|
| Managed Postgres primary, has replica on target-capable node | `switchover` (planned `pg_promote` after LSN catch-up) | seconds | replay LSN ≥ flush LSN before promote; `pg_is_in_recovery()=false` after |
| Managed Postgres primary, no replica | `standby-then-switchover`: temporary replica pinned to the destination, then switchover, then restore declared replica count | seconds | as above + per-table row counts |
| Managed cache primary | `REPLICAOF` (temp if needed) → `FAILOVER TO` | seconds | offsets equal; `DBSIZE` equal |
| Search / vector / plain volume, same or other node | `two-pass-copy` | ~a minute | file count + bytes + sha256 manifest |
| CSI volume | `follow` (volume availability drain) | seconds | volume published on the new node |
| Host has ZFS on both ends | `zfs-send` (incremental) | seconds | `zfs` snapshot guid |

**Two-pass copy, precisely.** A one-shot `swarmy-mover` container (alpine +
rsync + a small sha256 manifest script) runs on the **destination**, joined to
a per-move overlay, and pulls from an rsync daemon one-shot on the **source**
that mounts the volume read-only. Transport is the swarm overlay (and so the
mesh when on), never a published port. The one-time rsync secret is container
env only, like restic's. Steps:

1. Pass 1 while running: `rsync -aHAX --numeric-ids --delete --partial`.
2. Scale the service to 0 (managed members: the reconcile worker is told to
   hold via a `swarmy.move.inProgress` label so it does not fight us).
3. Pass 2 (only the changes). Then build a manifest on both sides and compare.
4. Rewrite the pin label (`swarmy.<kind>.node`) or `node.id==` constraint to
   the destination; for a disk-to-disk move, recreate the volume with the bind
   device instead.
5. Scale back; wait for running + healthy (the service's healthcheck, or
   `pg_isready`/`PING`).
6. The source volume is **renamed aside, not deleted**
   (`<name>.moved-<utc>`, like `pgdata.diverged-<utc>`), and removed only by an
   explicit "Delete old copy" after N days (default 7), with a reminder.

**Rollback** at any step before 6: re-pin to the source and scale back. The
source was never written after step 2, so it is exactly the last good state.

**Safety net:** before step 1, a restic snapshot if the latest one is older
than 24 h (skipped only if no backup destination exists, with a warning).

**Run state** (step reached, bytes copied) is the `swarmy.move.*` labels on
the service while running, plus an audit row per step (`volume.move.step`).
A controller restart resumes from the labels, like the mesh-migration runner.
No table.

**Effort:** L (≈ 7–8 days): mover image + agent command `volume.copy` (2 d),
the chooser + service + resumable runner (2.5 d), Postgres/cache switchover
wiring on the existing failover code (1.5 d), UI (1 d), e2e (1 d).

---

## 4. Phase 3 — "Retire a server" (the headline)

**Built:** `planDecommission(input)` in
`packages/trpc/src/services/node-decommission.plan.ts` (pure, 24 tests). It
takes the live inventory (all nodes with swarm info + disk, all services with
labels, the target's containers with mounts, `volume.list` drivers + sizes,
last backup per volume, the Garage replication factor) and returns:

- `steps[]` in run order, each with `kind`, a novice `title`, an expert
  `detail`, `destination`, `downtime` (`none`/`seconds`/`short`/`unknown`),
  `verify` and `rollback`;
- `blockers[]` with a `code`, message and a `fix`;
- `warnings[]` to acknowledge; `totals`; a one-sentence `summary`.

**Order** (and why):

1. `safety-backup` — restic every volume without a snapshot in 24 h.
2. `cordon` — **pause**, not drain: nothing new lands, data keeps serving.
3. `manager-promote` — if the target is the only manager, or leaving would
   make the count even while a worker exists.
4. `edge-handover` — if it is the only edge/outlet server, label a server with
   a public IP first; either way drop this server from geo-DNS and wait a TTL.
5. `garage-add-member` (if remaining members < replication factor) →
   `garage-leave` — started early because resync is the slowest step.
6. Databases: `db-switchover` / `db-standby-switchover`; caches:
   `cache-switchover` / `cache-replica-switchover`.
7. `volume-copy` per volume-backed service; `volume-follow` for CSI.
8. `drain` — stateless tasks and floating replicas reschedule.
9. `garage-await-resync` — the node must stay up until copies are whole.
10. `manager-demote` (leadership moves first if it is the leader).
11. `swarm-leave` (`node rm --force` if offline) → `mesh-remove` → `forget`.

**Offline target:** copies are impossible, so Postgres becomes a held
`db-failover` (the existing `decideFailover` rules — never silent data loss),
plain volumes become `volume-restore` from the newest snapshot (this is
dr-reconcile's path, run on purpose), and data with no replica and no backup
is a `data-unreachable` blocker.

**Destinations** come from `DestinationPicker`: schedulable servers only, the
disk must stay under 85% after the copy (node-hygiene's pressure line), the
same region first, then the fewest pinned data members, then the most room. It
reserves space as it goes, so two moves never count one disk twice.

**Blockers:** controller host, last working server, no manager candidate, no
destination with room, data unreachable, active-active writer (not automated),
no Garage replacement, no public-IP server for the edge role.

**Warnings:** bind-mount folders (swarmy never moves host folders), anonymous
scratch volumes, per-node volumes of a multi-replica service (dropped, not
merged), DB replica count that no longer fits, external DNS to repoint, an
even manager count, no backup destination.

**Runner (to build):** `decommission.service.ts` gathers the input from the
hub (`nodeInventory(includeOffline)`, `liveInventory`, `latestContainers`,
`latestNodeStats`, `volume.list` + a `du` probe, `Snapshot` rows,
`StorageCluster`), re-plans before **every** step (the inventory changes as
steps run, and a new blocker stops the run), and executes each step through
existing commands: `node.update` (pause/drain/labels/demote/promote), the
phase 2 mover, `manageddb` switchover, Garage admin curl, `mesh` peer delete,
`removeNode`. Progress = `swarmy.decom.*` **node labels** on the target
(`step`, `startedAt`) plus a `node.decommission.step` audit row per step; it
resumes after a controller restart. ABAC `node.decommission` (admin),
confirmation by typing the hostname. The target's disk is never wiped.

**Effort:** planner done. Runner L (≈ 6 days, after phase 2's mover), UI M
(3 days), e2e on the Lima multi-node harness (2 days: a 3-node cluster with a
managed PG primary, a volume app, Garage rf=2 and the edge on the target).

---

## 5. Phase 4 — "Spread and protect"

1. **Default standby for new managed Postgres when the swarm has 2+ servers:**
   topology `primary-replica` with 1 replica, anti-affine (this is already
   the default topology; `manageddb.provision` takes an explicit `replicas`,
   so the change is the create form, blueprints and the REST/Terraform
   defaults choosing 1 when `schedulable servers ≥ 2`, plus a gentle "add a
   copy" nudge on existing single clusters). Costs one extra ~100 MB Postgres per DB; show that in the
   create form. Caches keep 0 replicas by default (a cache can be rebuilt).
2. **Continuous restic to Garage:** already default-on for managed DBs
   (nightly `pg_dump`) and compose DBs. Add: plain named volumes of any stack
   get a nightly crash-consistent restic backup by default with an opt-out,
   and PITR (WAL shipping) as a one-click upgrade for managed Postgres.
3. **Garage replication factor follows server count:** rf = min(3, storage
   members); a one-server store says plainly "one copy only".
4. **A resilience check per server:** "If <server> died now, you would lose
   <X> (no replica, backup 3 days old)". This is a new check in
   `resilience.service.ts` fed by the phase 3 planner run with `online:false`
   for each server — the planner already answers "what happens if this server
   is gone", including `data-unreachable`.
5. **Replicated volume layer: not now.** Revisit only if users ask for shared
   RWX files: then JuiceFS-on-Garage as a "shared files" volume type, and
   LINSTOR/DRBD as an expert driver for owners with 4 GB+ servers.

**Effort:** S–M (≈ 3 days) for 1–4.

---

## 6. Phase 5 — "Disk-full prevention"

- **Forecast (built):** pure `forecastDiskFull(samples)` in `@swarmy/core`
  (`disk-forecast.ts`, with `diskForecastSeverity` and `describeDiskForecast`):
  least-squares line over the last 7 days of `MetricSample.diskUsedBytes` per
  node (telemetry.db, already sampled), ignoring drops (prunes, moves) by
  fitting only since the last large decrease. Output: bytes/day, days until
  85% and 100%, and a confidence (sample count, r²). Like `predict_linear`,
  but in the controller.
- **Alerts** (the existing alert rules): `disk-forecast` warning when full is
  < 14 days away, critical at < 3 days; the existing `disk-usage` 85% rule
  stays. Each alert carries a **concrete suggestion** computed from the same
  data: (1) "node-hygiene can free ~X GB" if reclaimable; (2) "the biggest
  thing here is <volume> (<size>) — move it to <server> (<free> free)" using
  `DestinationPicker`; (3) "add a disk: <provider> → attach a volume" with a
  deep link when the provider is known from node labels.
- A Postgres-specific guard: when a node with a managed primary passes 90%,
  the alert says so first — a full WAL disk stops the database.

**Effort:** S (≈ 2 days).

---

## 7. UX — Summary / Controls / Code

The redesign's layers: a novice reads a sentence; an expert opens controls;
anyone can see the exact commands.

**Server page → "Retire server"** (a secondary, not coral, action):

- **Summary:** the planner's `summary`, e.g. *"Retiring fra-2 moves 1
  database, 2 volumes (about 3.4 GB) and 6 apps to other servers. Databases
  pause for a few seconds while they switch over."* Then blockers in red, each
  with its fix button ("Add a server", "Promote hel-1"). Then the warnings as
  a checklist to tick.
- **Controls:** the step list, each row showing the title, destination (a
  dropdown to override, re-validated by the planner), and pause estimate.
  Toggles: skip safety backup (with a warning), keep old copies N days.
  "Run" → a live progress list (current step spinning, done steps with their
  verify line, a "Stop after this step" button). Rollback per completed step
  where it exists.
- **Code:** each step's `detail`, plus the literal commands the runner will
  dispatch (`docker node update --availability pause fra-2`, the rsync
  one-shot spec, `SELECT pg_promote()`, `garage layout remove …`).

**Volume row → "Move"**: Summary = *"Move uploads (1.2 GB) to hel-1. The blog
pauses for about a minute."* Controls = destination server or disk, verify
level. Code = the mover spec.

**Disk card on the server page:** a bar (used / total) with the forecast line
*"Full in about 11 days at the current rate"*, and an **"Add a disk"**
explainer when a blank disk is detected: *"We found a new 100 GB disk
(sdb, serial …3F9A). Format it and use it for new data?"* — the typed
confirmation is the last 4 of the serial. A disk with data offers only "Mount
as-is".

Vocabulary: **server**, not node; **copy**, not replica, in Summary text;
engine words (`replica`, `LSN`, `layout`) only in Controls/Code.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Formatting the wrong disk | Agent-side re-probe right before `mkfs`, serial match, typed confirmation, refuse any signature. Never an auto-format. |
| Split-brain during a DB switchover (two writers) | Reuse the existing promotion path only (`decideFailover`, rejoin epoch, PGDATA aside). The old primary is stopped **before** promote in a planned switchover. |
| Reconcile workers fighting a move (rescaling a service we scaled to 0) | `swarmy.move.inProgress` label that every reconcile worker skips; cleared on finish or rollback. |
| rsync of a large volume over a slow link takes hours | Pass 1 runs live (no pause) and shows progress + ETA; only pass 2 pauses. Estimate from size before starting. |
| Disk estimate wrong (sizes unknown) | Planner marks unknown sizes; the runner probes `du` before each copy and re-plans. |
| Garage resync slower than expected | Node stays up until the queue is empty; the step never times out into "leave anyway". |
| Controller restart mid-run | Labels + audit rows make every step resumable; steps are idempotent by id. |
| Offline server with no copy anywhere | A blocker, never a best effort. |
| Provider-specific quirks (EBS 6 h limit) | Surface in the "grow disk" text; swarmy does not call provider APIs in this epic. |

---

## 9. Where state lives (docker-native-storage)

- Disks: node labels `swarmy.disk.<uuid>`, `swarmy.disk.default`.
- A running move: service labels `swarmy.move.*` (step, destination, epoch).
- A running decommission: node labels `swarmy.decom.*` on the target.
- History: audit rows (`volume.move.*`, `node.decommission.*`, `node.disk.*`).
- Forecast input: the existing `MetricSample` rows in telemetry.db.
- **No new Prisma model.** No schema change in phases 1–5.

---

## 10. What we explicitly won't do

- No replicated block/file layer by default (no Ceph, Gluster, Longhorn-alike,
  DRBD, SeaweedFS mounts under databases).
- No automatic formatting, ever, and no formatting of a disk with any
  signature, even with confirmation.
- No moving `/var/lib/docker` (`data-root`).
- No LVM spanning by default (it ties disks' fates together).
- No calls to cloud provider APIs to create/attach/resize volumes in this epic
  (a later "provider connector" could).
- No automatic decommission on its own (e.g. on a dead server): swarmy plans
  and waits for a person, except dr-reconcile's existing restore-on-recovery.
- No deleting the source copy as part of a move or a decommission.
- No live migration of active-active Postgres writers; no engine-aware moves of
  compose (non-managed) databases in the first cut.
- Moving the controller itself is out of scope (a blocker in the planner).

---

## 11. Owner decisions

1. **Default standby:** give new managed Postgres a replica by default when
   there are 2+ servers (+~100 MB RAM per DB)? Recommended: yes.
2. **Default volume backups:** back up every named volume nightly by default
   (restic to Garage), with an opt-out? Recommended: yes.
3. **Old copies:** keep the source copy after a move for 7 days, then prompt?
   Or keep until deleted by hand?
4. **Filesystem for new disks:** ext4 only, or offer XFS too?
5. **The container agent formatting disks** needs a privileged one-shot with
   the host root mounted. Acceptable, or systemd-agent only for phase 1?
6. **A replicated volume layer later:** JuiceFS-on-Garage for shared files is
   the only one worth building; confirm "not now".
7. **Edge handover:** auto-pick the replacement edge server, or always ask?

## 12. Build order and total

Phase 3 planner (done) → phase 5 forecast (S, pure, high value) → phase 2
mover (L) → phase 3 runner + UI (L+M) → phase 1 add-a-disk (M) → phase 4 (S–M).
Total ≈ 5–6 weeks for one engineer.
