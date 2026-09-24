# Epic: Docker-native control-plane state (no database server)

Status: **plan, 2026-09-24.** Pre-launch — no back-compat, no data migration
for existing installs beyond "restore a controller bundle".

Owner direction: *"Ideally we shouldn't be using even Postgres — use Docker
Swarm, labels and things like that to store information as much as we can. I
don't want to run a database to store the controller config unless we
desperately need one."* And: swarmy is your own cloud; it may not depend on any
other cloud or platform.

Scope: swarmy's **own** control-plane state. Managed databases for user apps
(`swarmy.db.*` Postgres clusters, caches, search, vectors) are a product feature
and are untouched.

---

## 1. The verdict

**We do not need a database *server*. We do need a database *file*.**

- **Infra truth stays Docker.** 6 of the 85 models go away (derive from live
  Docker / hub state, or dead code).
- **Small, reconciler-converged infra config moves into the swarm** (16 models):
  Swarm configs used as a versioned, compare-and-swap document store, plus
  service/node labels. It survives loss of the controller's volume, because
  the raft store on every manager holds it.
- **Identity, access control, audit, history, outboxes and credentials (63
  models) need a real transactional, queryable store.** Raft can't be that store:
  it has no queries, no transactions across objects, configs can't be changed
  once created, every write is replicated to every manager, and it grows the
  raft snapshot that new managers must stream. Better Auth can't run on it
  either.
- That store is **embedded SQLite** (`bun:sqlite`, WAL) in the controller
  process, **continuously replicated into swarmy's own Garage** with Litestream
  (one static binary, like restic), and **restored on boot** when the controller
  task lands on a node with an empty volume. No Postgres service, no port, no
  `DATABASE_URL`, no standard tier.

### What the evidence changed in the working hypothesis

1. **Most of this is already true.** The default *lite* tier
   (`deploy/swarmy.lite.stack.yml`) runs **no database service**. It uses PGlite,
   an embedded WASM Postgres, in the controller process on the `swarmy-data`
   volume. A Postgres *service* runs only on the opt-in `--standard` tier
   (`deploy/swarmy.standard.stack.yml`) and in the "upgrade to managed Postgres"
   path (`controllerDb.service.ts`). Epic #6 already removed Service, Deployment
   and Node status/labels from the DB. So the first win is **deleting the
   standard tier**, which is cheap.
2. **PGlite vs SQLite is the real engine question, and SQLite wins.** We
   rejected SQLite once (`docs/product/resilience-and-dr.md` → "Explicitly
   rejected") because of "enums, jsonb, BigInt ids, timestamptz, many
   concurrent writers". Checked against the code today, those reasons mostly
   no longer hold:
   - *Concurrent writers:* PGlite is single-connection, and its adapter
     already runs every transaction one at a time (`pglite-adapter.ts`
     header). SQLite in WAL mode (one writer, many readers) is the same model
     or better.
   - *Dialect:* Prisma's SQLite provider supports `Json`, `enum` and `BigInt`.
     What doesn't port: 2 `String[]` columns (`GitRepo.envBranches`,
     `AppPlan.confirmedIds` → `Json`), the `@db.Text`/`@db.Timestamptz`
     annotations (drop them), and **5 raw-SQL call sites**
     (`controllerBackup.dump.ts` ×3 using `pg_catalog`, `domain-checks.store.ts`
     using jsonb `||`, and the uptime `date_trunc … FILTER` in
     `statusPages.service.ts` + `status-public.ts`). No `mode: 'insensitive'`,
     no Json path filters and no array filters appear anywhere.
   - *What PGlite costs us:* it needs at least 128 MiB of WASM memory, peaks near
     1 GiB during initdb (worked around with an image-baked template), ships a
     597-line in-repo Prisma adapter, and **can only be backed up as a logical
     `INSERT` dump**, so it has no continuous replication. That last point is
     why the controller today is pinned by `node.hostname` and can't move
     between nodes (`docs/product/footprint.md`, stack placement comment).
   - *What SQLite gives us:* a few MB of memory, durability proven over
     decades, `VACUUM INTO` hot snapshots, and Litestream WAL shipping to any S3
     API (Garage). Together those let the controller **float between
     managers** with an RPO of about 1 s.
3. **Docker secrets are the wrong place for controller-runtime secrets.** The
   Docker API never returns a secret's data. A secret can only be *mounted* into
   a task, so every new secret would mean a controller service update and a
   restart. Secrets that live in the swarm are therefore stored as
   **vault-encrypted payloads inside Swarm configs** (`SWARMY_SECRET_KEY`, the
   existing `encryptSecret`). Docker secrets stay what they are today: the
   controller's own boot secrets and secrets injected into user apps.
4. **The controller has no Docker socket.** Every Docker read or write goes
   through an agent on a manager (`resolveManagerNode` + `ctx.hub.dispatch`).
   Swarm-stored config therefore needs an in-memory cache that is loaded at boot
   and written through on change. Identity and auth can't depend on an agent
   being connected: sign-in must work while node #1's agent is still dialling
   in. That's one more reason auth lives in the local file.
5. **Some config is better left in SQLite.** Product config (alert rules,
   channels, templates, status pages, jobs, workflows, inbound/outbound webhook
   endpoints, AI keys, guardrails) has a history table hanging off it
   (`AlertRule→AlertEvent`, `StatusPage→UptimeSample`, `ScheduledJob→JobRun`,
   `InboundEndpoint→InboundDelivery`, …). It is looked up on public request
   paths and isn't infra. Putting the parent row in raft and its children in
   SQLite loses cascades and joins, and gains nothing the replicated file and
   the restic bundle don't already give. So class (b) is limited to **infra
   desired-state that a reconciler converges, or that DR needs before the
   controller store exists**.

---

## 2. The three homes

### (a) Derive: live Docker / hub state, no table

Read from `ctx.hub.liveInventory` / `buildInventory` / agent reports and the
driver APIs (the `docker-native-storage` pattern). Ephemeral *columns* on models
that are kept also move into memory (listed in §3).

### (b) Store in the swarm: `swarm-kv` + labels

- **Labels** (service `Spec.Labels`, never `ContainerSpec.Labels`, which restart
  tasks; node labels) hold per-object declarative values of up to a few KB:
  `swarmy.<area>.<key>`, one JSON label per structured value.
- **`swarm-kv`** is a new `@swarmy/core` + trpc service that uses Swarm
  configs as a document store:
  - A document is the config `swarmy-kv.<org>.<key>.<seq>` with labels
    `swarmy.kv.key`, `swarmy.kv.seq` and `swarmy.kv.sha`. The latest document
    is the highest `seq` found by a label-filtered list.
  - **Compare-and-swap for free:** config names are unique in raft, so a write
    of `seq+1` that loses a race fails with "name exists". The writer then
    re-reads and retries.
  - Payload ≤ 500 KB (the Docker limit). Budget ≤ 64 KB per document and
    ≤ 2 MB for swarmy's whole raft footprint, so manager snapshots stay small.
    Keep the last 3 versions and prune the older ones. The retained versions
    double as a one-click "undo config".
  - Secret fields inside a document are `encryptSecret(...)` ciphertext (fact
    3 above). Raft is encrypted at rest; autolock protects its key.
  - Loaded into memory at boot (after the first manager agent registers) and
    written through on change. Reads never touch Docker. If no manager agent
    is connected, writes fail loudly (`commandRejected`); they are never
    queued in secret.
  - These documents are **not mounted into any service**, so writing one
    restarts nothing. A reconciler renders what it needs from them and
    dispatches as it does today.

**Raft limits, stated plainly.** Only a manager can write, and a write needs
quorum. There is no query language, so the inventory is scanned in memory.
Configs can't be edited, so each change is a new object. Every write is a raft
log entry replicated to every manager, and big or churny state bloats the raft
snapshot a joining manager must stream. Anyone with Docker API access on a
manager can read labels and config payloads, which is why every secret is
encrypted by the vault. So (b) is only for data that is **small, changes at
human speed (a few writes per day per org), and holds desired config**. Never
counters, timestamps, run state, or anything written per request or per tick.

### (c) Embedded store: SQLite in the controller, replicated to Garage

- `bun:sqlite`, WAL, `synchronous=NORMAL`, `busy_timeout`, and one writer
  connection, which matches today's PGlite model.
- Two files on the `swarmy-data` volume:
  - `control.db`: everything in class (c) except telemetry. Replicated.
  - `telemetry.db`: `MetricSample` only. It can be rebuilt and is already
    left out of backups (`EXCLUDED_TABLES`). Not replicated. When
    observability is on, it moves to the ClickHouse store in a later phase.
- Replication: the controller image ships `litestream`, and the entrypoint runs
  `litestream restore -if-db-not-exists -if-replica-exists` and then
  `litestream replicate -exec "<controller>"`. The replica is a dedicated
  Garage bucket, `swarmy-control`, with its own vault-encrypted key. With no
  Garage (a single node, not yet enabled), the file stays local and the
  nightly restic bundle is the only off-node copy. The UI's Resilience score
  already shows that honestly.
- **A floating controller needs fencing.** Placement changes from
  `node.hostname == X` to `node.role == manager`. Swarm's `replicas: 1` +
  `stop-first` can still leave a task running on a partitioned node. The fence
  is a **raft-backed lease**: the controller renews
  `swarmy.controller.lease=<taskId>:<epoch>` on its own service spec every 10 s
  through a version-checked `service update`. Docker's spec version index
  makes that an atomic compare-and-swap. A controller that fails to renew
  within 30 s stops writing, stops Litestream and exits. A new task restores
  from the replica only after it has taken the lease.
- The controller bundle (`controllerBackup.*`) swaps the `INSERT` dump for
  `VACUUM INTO` (a consistent single file). Restoring becomes "put the file
  in place, then run `ensureSchema`".
- Better Auth: `prismaAdapter(db, { provider: 'sqlite' })`, which Better Auth
  supports (`packages/auth/src/server.ts:155`).

---

## 3. Inventory: all 85 models

Write rate: **R** = rare, changes at human speed · **A** = once per user or
system action · **T** = every worker tick · **Q** = every request or event.
Growth: **fixed** (singleton or per-object) · **grows** (append-only,
retention-pruned or not).

### auth.prisma (8): all (c)
| Model | Holds | Write | Growth | Read by | Relations | Class |
|---|---|---|---|---|---|---|
| User | identity | A | grows slowly | Better Auth, every procedure | hub of FKs | c |
| Session | session tokens + MFA assurance | Q (refresh) | grows, expires | every request | User | c |
| Account | credential / OAuth tokens | A | per user | Better Auth | User | c |
| TwoFactor | TOTP secret, backup codes | A | per user | Better Auth | User | c |
| Verification | magic link / OTP values | Q | short-lived | Better Auth | – | c |
| Organization | tenant | R | fixed | everything | FK root | c |
| Member | membership + ABAC attrs | R | per user | orgProcedure | Org, User | c |
| Invitation | pending invites | A | short-lived | members UI | Org, User | c |

### access.prisma (5): all (c)
| AuthProviderConfig | social login config + encrypted secret | R | fixed | Better Auth boot | – | c |
|---|---|---|---|---|---|---|
| SsoProvider | OIDC/SAML provider (Better Auth sso plugin table) | R | fixed | sign-in by domain | Org | c |
| Policy | ABAC Cedar/JSON policies | R | small | abacProcedure | Org | c |
| ResourceGrant | ReBAC tuples | A | grows with users×resources | abacProcedure | Org, unique tuple | c |
| OrgSecurityPolicy | require-2FA policy | R | singleton | orgProcedure | Org | c |

### api.prisma (4)
| ApiKey | hashed API keys | A (+ lastUsedAt Q) | small | REST auth, every call | Org, User | c |
|---|---|---|---|---|---|---|
| OAuthClient | client-credentials | R | small | REST auth | Org | c |
| WebhookEndpoint | outbound endpoint + encrypted secret | R | small | delivery worker | → deliveries | c |
| WebhookDelivery | durable outbox | Q | grows | delivery worker | endpoint | c |

### ai.prisma (4): all (c)
| AiProviderConfig | provider refs + encrypted keys | R | singleton | gateway | Org | c |
|---|---|---|---|---|---|---|
| AiVirtualKey | hashed virtual keys + limits | R | small | every gateway request | → usage/log | c |
| AiUsage | per-request tokens/cost | Q | grows fast | budgets, cost UI | key | c |
| AiRequestLog | redacted prompts (opt-in) | Q | grows fast | audit UI | key | c |

### alerts.prisma (7): all (c)
| NotificationChannel | channel config (encrypted) | R | small | alert fan-out | Org | c |
|---|---|---|---|---|---|---|
| AlertRule | rules + default tombstones | R | small | alert-evaluator T | → events | c |
| AlertEvent | firing/resolved history | A | grows | UI, dedupe | rule | c |
| Incident | incidents | A | grows | UI, status page | → events | c |
| IncidentEvent | timeline | A | grows | UI | incident | c |
| StatusPage | public page config | R | small | public route per request | → samples | c |
| UptimeSample | 1/component/min | T | ~130k/component/90d | status page aggregates | page | c |

### backups.prisma (12)
| BackupTarget | S3/node destination + encrypted creds | R | small | every backup, **DR** | → snapshots, schedules | **b** |
|---|---|---|---|---|---|---|
| Snapshot | restic run history + hostNodeId | A | grows | Resilience, dr-reconcile | target | c |
| ControllerBackupConfig | controller schedule/retention/passphrase ref | R (+ lastRunAt/nextRunAt T) | singleton | scheduler, **DR** | target | **b** (run times → derive from ControllerSnapshot) |
| ControllerSnapshot | controller bundle history | A | grows | UI, restore | target | c |
| StorageCluster | Garage driver/members/layout/key refs/engine upgrade | R | singleton | garage reconcile | – | **b** (members/layout → Garage admin API + service labels; `engineUpgrade` run state → a label on the Garage service) |
| BucketAccess | per-bucket INTERNAL/MESH/PUBLIC | R | small | edge render | – | **b** |
| ClusterVolume | CSI cluster volumes | – (0 writers) | – | 1 count | – | **a** (`docker volume ls --cluster`) |
| BackupSchedule | per-volume schedule, auto/opt-out | R (+ last/next T) | small | backup-scheduler | → jobs | **b** (last/next → derive from BackupJob) |
| BackupJob | run history | A | grows | UI | schedule (→ string) | c |
| RestoreOperation | restore history | A | grows | UI, dr-reconcile | – | c |
| OffsiteMirror | mirror config + encrypted Garage key | R (+ last/next T) | singleton | mirror worker | → runs | **b** (`grantedBucketIds` → Garage key permissions, derived) |
| OffsiteMirrorRun | run history | A | grows | UI | mirror (→ string) | c |

### cicd.prisma (9)
| GitRepo | repo binding, tokens, lastAppliedSha | A | small | webhooks, git-apps loop | connection, → builds/plans | c |
|---|---|---|---|---|---|---|
| GitHubApp | controller's GitHub App (encrypted keys) | R | singleton | webhooks, token mint | → connections | c |
| GitConnection | provider auth, refreshed OAuth tokens | A (token refresh) | small | git ops | app, → repos | c |
| Build | build history | A | grows | CI UI | repo | c |
| RegistryConfig | registry policy + cosign keypair | R | singleton | admission, registry reconcile | – | **b** |
| ImageGcPolicy | GC mode/days | R | singleton | image-gc worker | – | **b** |
| ImageScan | Trivy reports | A | grows | admission, UI | – | c |
| RegistryCredential | third-party pull creds (write-only) | R (+ lastTest*) | small | every pull/build | unique prefix | c |
| AppPlan | swarmy.yaml plan/ledger history | A | grows | git-apps loop | repo | c |

### cluster.prisma (9)
| Node | enrolment id + hashed reconnect credential | A | per node | gateway auth, 44 readers | → metrics, claims | c |
|---|---|---|---|---|---|---|
| RecoveryClaim | recovery-beacon flow | A | short-lived | gateway, UI | node | c |
| JoinToken | hashed join tokens, `uses` counter | A | small | enrol | → nodes | c |
| Stack | the user's compose source + ingressDriver | A | per stack | deploy, 23 sites | – | **b** (compose → `swarm-kv` doc per stack, versions double as undo; ingressDriver → `swarmy.stack.ingressDriver`) |
| MetricSample | 1/node/min | T | grows, 14 d retention | metrics, cost | node | c (`telemetry.db`) |
| AuditLog | every mutation | Q | grows forever | audit UI, ABAC | User | c |
| IdempotencyKey | REST idempotency cache | Q | TTL | REST middleware | – | c |
| SwarmConfig | swarm id, manager addr, join tokens, unlock key | R | singleton | swarm/recovery services | – | **a** (id/addr/join tokens via `docker info` / `swarm join-token -q` on a manager; the opt-in unlock-key escrow → one encrypted row in `control.db`, because it must exist while the swarm is locked) |
| CanvasLayout | canvas node positions + viewport | A (drag) | singleton | canvas | – | **b** (positions → the existing `swarmy.canvas.x/y` service labels; viewport → browser `localStorage`) |

### geodns.prisma (3): all (b)
| GeoDnsConfig | geoip source refs | R | singleton | dns snapshot | – | **b** |
|---|---|---|---|---|---|---|
| DnsZone | zones, pinned NS nodes, serial | R (serial on content change) | small | dns-reconcile | → records | **b** (one `swarm-kv` doc per zone, zone + records; `serial` = the doc's `seq`) |
| DnsRecord | manual MX/TXT/… | R | small | dns snapshot | zone | **b** (inside the zone doc) |

### governance.prisma (2): (c)
| ExposureConfig | exposure rules | R | singleton | deploy admission | – | c (policy family: audited with Policy) |
|---|---|---|---|---|---|---|
| GuardrailConfig | guardrails, prod-safety mode | R | singleton | deploy admission | – | c |

### ingress.prisma (2)
| IngressConfig | driver + settings + `domainChecks` results | R (+ domainChecks T) | singleton | edge render, 12 sites | – | **b** (driver/settings → `swarm-kv`; `domainChecks` are probe results → in memory, re-probed on boot) |
|---|---|---|---|---|---|---|
| Tunnel | Cloudflare tunnel rows | – (**0 call sites**) | – | none | – | **a** (dead code: delete; cloudflared config lives in ingress settings) |

### jobs.prisma (5): all (c)
| ScheduledJob | cron job defs (+ lastRunAt T) | R | small | job-scheduler | → runs | c (lastRunAt → derive from JobRun) |
|---|---|---|---|---|---|---|
| JobRun | run history + output tail | A | grows | UI | job | c |
| WorkflowDef | versioned step defs | R | small | runner | → runs | c |
| WorkflowRun | run state machine (cursor) | T | grows | workflow-runner | def | c |
| WorkflowStepRun | step results | T | grows | UI | run | c |

### mesh.prisma (4)
| MeshConfig | driver, mgmt URL, control plane, settings | R | singleton | mesh reconcile, 12 sites | – | **b** |
|---|---|---|---|---|---|---|
| MeshPeer | per-node peer id/IP/status/lastSeen | T | per node | mesh UI, 14 sites | – | **a** (status/IP/lastSeen from the agent's `meshState`; `peerId` → node label `swarmy.mesh.peerId`) |
| MeshRoute | direct-connect grants (principal, expiry) | A | small | mesh ACL render | → acls | c (access control) |
| MeshAcl | rendered ACL + appliedAt | T | per route | none (0 readers) | route | **a** (render from MeshRoute on demand) |

### notifications.prisma (3): all (c)
| NotificationConfig | SMTP/Resend config (encrypted) | R | singleton | mailer | – | c |
|---|---|---|---|---|---|---|
| NotificationTemplate | templates | R | small | mailer | – | c |
| NotificationDelivery | send history | Q | grows | UI | – | c |

### observability.prisma (2)
| ObservabilityConfig | enabled, ClickHouse DSN, retention, collectorStatus | R (+ status T) | singleton | observability reconcile | – | **b** (DSN encrypted in the doc; collectorStatus → derive from the collector service's live tasks) |
|---|---|---|---|---|---|---|
| ObservabilityStoreState | ClickHouse reachability/disk | T | singleton | 1 reader | – | **a** (live probe, hub cache) |

### releases.prisma (1)
| Release | per-deploy compose + digests + health gate | A | grows | rollback, UI | – | c |
|---|---|---|---|---|---|---|

### terminal.prisma (3): all (c)
| TerminalPolicy | exec/shell policy, MFA window | R | singleton | terminal gateway | – | c (security policy) |
|---|---|---|---|---|---|---|
| TerminalSession | session record, recording ref | A | grows | audit UI | – | c |
| TerminalApproval | node-shell approvals | A | short-lived | terminal gateway | – | c |

### webhooks.prisma (2): (c)
| InboundEndpoint | public receiver config (encrypted verify secret) | R | small | public route per request | → deliveries | c |
|---|---|---|---|---|---|---|
| InboundDelivery | received payloads ≤256 KB, retry queue | Q | grows, retention | dispatch worker | endpoint | c |

### Counts

| Class | Models | Share |
|---|---|---|
| **(a) derive / delete** | 6: ClusterVolume, SwarmConfig, Tunnel, MeshPeer, MeshAcl, ObservabilityStoreState | 7 % |
| **(b) store in swarm** | 16: BackupTarget, ControllerBackupConfig, BackupSchedule, OffsiteMirror, StorageCluster, BucketAccess, RegistryConfig, ImageGcPolicy, Stack, CanvasLayout, GeoDnsConfig, DnsZone, DnsRecord, IngressConfig, MeshConfig, ObservabilityConfig | 19 % |
| **(c) embedded SQLite** | 63 (62 in `control.db`, MetricSample in `telemetry.db`) | 74 % |

Also moved to memory or derived, on models that are kept: `ControllerBackupConfig.lastRunAt/nextRunAt`,
`BackupSchedule.lastRunAt/nextRunAt`, `OffsiteMirror.lastRunAt/nextRunAt/grantedBucketIds`,
`ScheduledJob.lastRunAt`, `IngressConfig.settings.domainChecks`,
`ObservabilityConfig.collectorStatus`, `StorageCluster.memberNodeIds/layout/engineUpgrade`.
The rule: **no timestamp, counter or run state in raft.**

---

## 4. Options for class (c), weighed

| Option | Separate server? | Queries/tx | Better Auth | Replication / failover | Memory | Verdict |
|---|---|---|---|---|---|---|
| Postgres service (standard tier) | **yes** | full | yes | none built (pinned, restic dump) | 100 MB+ extra service | **drop** |
| PGlite (today's lite) | no | full PG | yes | logical dump only → controller pinned to one host | ≥128 MiB WASM, 1 GiB first-boot peak without template | viable fallback |
| **SQLite + Litestream → Garage** | no (sidecar binary in the same container) | full SQL, one writer | yes (`provider: 'sqlite'`) | ~1 s RPO, restore-on-boot, floating controller | a few MB | **choose** |
| Append-only JSONL/objects in Garage | no | none (no joins, no uniques, no tx) | **no** | native | small | reject: re-implements a DB badly; Better Auth can't use it |
| Swarm raft for everything | no | none | no | native | – | reject: see raft limits in §2(b) |

**Prisma on Bun + SQLite:** Prisma's docs say `better-sqlite3` doesn't run
under Bun and point to `@prisma/adapter-libsql` instead. We already maintain
an in-repo driver adapter (PGlite), so the preferred path is a **`bun:sqlite`
`SqlDriverAdapter`**, a much smaller mapping than PGlite's OID table, with
`@prisma/adapter-libsql` (local `file:` URL) as the no-code fallback. A
one-day spike settles which (P2 gate).

### Do we "desperately need" a database?

**Yes for a durable, transactional, queryable store; no for a database
server.** Sessions, API keys, the audit log, ABAC grants, outboxes and run
history need uniqueness, transactions, retention deletes and filtered queries
at request speed. Better Auth needs a SQL adapter. Raft gives none of that and
would bloat for every manager. An embedded SQLite file is the smallest thing
that meets those needs. It's a library, not a service.

---

## 5. Phased migration

Pre-launch: each phase lands on a clean install. Existing dev data moves by a
controller bundle restore, or not at all.

### P0: delete the Postgres service path (S, 1–2 days)
- Remove `deploy/swarmy.standard.stack.yml`, installer `--standard`/`DB_TIER`,
  the `postgres_password` secret and `swarmy-pgdata`; `controllerDb.service.ts`
  (managed `swarmy-postgres` upgrade) and its UI; `@prisma/adapter-pg`/`pg` from
  the runtime path (dev keeps docker-compose Postgres only until P2).
- Docs: `run-local` skill, README, `resilience-and-dr.md`, `footprint.md`.
- Done when a fresh install has no Postgres service, the one-liner and e2e smoke
  are green, and no `DATABASE_URL` is set in prod.

### P1: derive class (a) and the ephemeral columns (M, 3–5 days)
- Delete `Tunnel` (dead), `MeshAcl`, `ClusterVolume`, `ObservabilityStoreState`,
  `MeshPeer` (→ agent `meshState` + `swarmy.mesh.peerId` node label),
  `SwarmConfig` (→ manager `docker info`/`join-token`; unlock-key escrow → a
  `vault_entry` row).
- Move the run-state columns listed in §3 into memory or derive them from
  the history tables.
- Done when typecheck and tests pass, `prisma db push` runs on the empty
  schema, and the UI shows the same values fed live.
- **Landed 2026-09-24.** The six models are gone. `SwarmConfig`'s join material
  is read from a live manager and cached in memory (the installer's tokens
  prime it at boot); a known swarm with no connected manager waits a minute
  before re-electing. The unlock-key escrow is a `VaultEntry` row. `MeshPeer`
  is a live map fed by `meshState` + `listPeers`; `MeshRoute` stays (grants,
  also person grants in `epic-self-hosted-mesh-and-fleets.md`). `ClusterVolume`
  did have a (cast) writer; it is now a live `volume.list` on a manager.
  Schedule last/next run is derived from run history; `grantedBucketIds`,
  `collectorStatus` and domain-check probe results are in memory (the
  domain gate itself stays in `IngressConfig.settings`). `StorageCluster`
  members/layout/engineUpgrade are left to P4 slice 2, where the whole model
  moves to `swarm-kv`.

### P2: SQLite engine swap (M, 1–1.5 weeks, gated by a 1-day spike)
- Spike: Prisma 7 + `bun:sqlite` adapter (or `adapter-libsql`) passes
  `packages/db` + `packages/auth` + `packages/trpc` tests. **If the spike fails,
  stop here, stay on PGlite and skip P3's floating controller.** P0/P1/P4 still
  land.
- `datasource provider = "sqlite"`. Strip the `@db.*` annotations; `String[]` →
  `Json`. Squash the 18 migrations into one SQLite baseline (pre-launch).
  Retarget `ensureSchema`.
- Port the 5 raw-SQL sites: uptime daily aggregate (`strftime('%Y-%m-%d', at)`,
  `count(*) FILTER (…)` works in SQLite ≥ 3.30); `patchDomainChecks` goes away
  in P1 (in memory); the dump moves to `VACUUM INTO`.
- Better Auth `provider: 'sqlite'`. Split `MetricSample` into `telemetry.db`.
- Delete `pglite-adapter.ts`, the PGlite template build and `SWARMY_PGLITE_*`.
- Done when the full test suite passes, e2e install→ONLINE→deploy is green, and
  a measured controller RSS on a 1 GB VPS is recorded in `footprint.md`.

### P3: replicated, floating controller (M, 1 week)
- Ship `litestream` in the controller image. The entrypoint does
  restore-if-empty, then `replicate -exec`. Auto-create the `swarmy-control`
  Garage bucket and key when Garage is enabled. Show "controller store:
  local only / replicated (lag Ns)" on Resilience.
- The raft lease fence (§2c). Placement `node.role == manager`, volume stays
  `local` (restore on the new node).
- The controller bundle uses the `VACUUM INTO` file. The CLI restore puts the
  file in place.
- Done when a drill passes: drain the controller's node, the task starts on
  another manager, restores from Garage, agents re-adopt, and the last write
  before the drain is still there. A second drill: partition the old node and
  confirm it self-fences within 30 s.

### P4: `swarm-kv` + class (b) (L, 2–3 weeks)
- Build `swarm-kv` (CAS'd versioned configs, encrypted fields, boot load,
  write-through cache, prune to 3, "undo to previous version") + the
  `service.updateLabels`/node-label paths that already exist.
- Migrate in 4 slices, each deleting its Prisma models (FKs → plain strings):
  1. **Edge & net:** IngressConfig, MeshConfig, GeoDnsConfig, DnsZone+DnsRecord,
     ObservabilityConfig.
  2. **Storage:** StorageCluster, BucketAccess.
  3. **Backups/DR:** BackupTarget, BackupSchedule, ControllerBackupConfig,
     OffsiteMirror. After this slice, **a controller that loses its volume
     and has no Garage replica still knows where its backups are**, because
     the raft store holds them. The CLI restore reads the target from
     `swarm-kv` through any manager agent.
  4. **Apps & registry:** Stack (compose doc per stack), CanvasLayout,
     RegistryConfig, ImageGcPolicy.
- About 300 Prisma call sites across these 16 models (counted from the code).
- Done per slice: raft footprint ≤ 2 MB on a seeded org (measure with `docker
  config ls` sizes), reconcilers converge from `swarm-kv` alone, and a restore
  from an empty `control.db` rebuilds the slice's view.

**Total: about 6–8 engineer-weeks.** P0+P1 (about 1.5 weeks) meet the "no
database service" direction. P2+P3 remove Postgres entirely and make the
controller movable. P4 gives the most "state lives in the swarm" and costs
the most.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Prisma's SQLite driver on Bun is immature | The P2 spike gates it. `adapter-libsql` as fallback. PGlite as the final fallback (no DB server either way). |
| Split-brain after a partition (two controllers, two WAL lineages) | Raft-lease fence with self-fencing; restore only after taking the lease. Litestream generations mean at worst one side's writes are lost, never corruption. Drilled in P3. |
| Litestream ↔ Garage S3 compatibility | Verify in the P3 spike (List v2, multipart, DeleteObjects). Fallback: an in-process `VACUUM INTO` snapshot + upload every 60 s (RPO 60 s). |
| Raft bloat from `swarm-kv` | Budget ≤ 64 KB per doc and ≤ 2 MB total, prune to 3 versions, no run state in raft (lint: `swarm-kv` rejects keys outside an allowlist). |
| `swarm-kv` unavailable when no manager agent is connected | Write-through cache serves reads; writes fail loudly. Auth/identity never depends on it (class c). |
| Config visible to anyone with Docker API access on a manager | Every secret field vault-encrypted. Such a user already owns the swarm. |
| SQLite single writer under load | Controller scale is tens of writes/s at peak (per-request AuditLog, Session, AiUsage). WAL handles thousands. Keep hot telemetry in `telemetry.db`. |
| Garage absent on small installs | Local file + nightly restic bundle (today's guarantee). Resilience score shows "controller store not replicated". |

## 7. What we lose

- **Postgres features**: jsonb operators, `date_trunc`, array columns,
  `pg_catalog` introspection (5 call sites, ported), and the option of pointing
  swarmy at an external/BYO Postgres (dropped on purpose, per "own cloud").
- **One dialect everywhere**: user-app managed DBs stay Postgres; the control
  plane becomes SQLite. Two dialects in the repo, cleanly separated.
- **Horizontal controller scale**: never existed (single replica today). SQLite
  makes it explicit: one writer, fenced.
- **Query-ability of class (b)**: config in raft is read whole and filtered in
  memory; no SQL joins against it (by design; it's small).
- **Zero-RPO**: failover RPO is Litestream lag (about 1 s), 0 only on a
  clean shutdown. Without Garage, RPO is the bundle interval.

## 8. Docs & skills to update as phases land

- `docker-native-storage` skill: add the `swarm-kv` home and the "no run state in
  raft" rule; the "Stays in the DB" list becomes "embedded store".
- `backups-dr` skill + `docs/product/resilience-and-dr.md`: reverse the "SQLite
  rejected" entry (with the evidence in §1), and cover the Litestream replica,
  the lease fence and the floating controller.
- `docs/product/footprint.md`, the `run-local` skill (no Postgres in dev after
  P2), `README.md`.

## Decision (2026-09-24)

The owner keeps **PGlite** as the controller engine. It is already embedded in the
controller process, so swarmy runs no database service by default. This plan stays
as a reference and is **not scheduled**. The opt-in `--standard` tier and the
managed-Postgres upgrade path stay for now.

Early findings from the stopped SQLite spike (Prisma 7.8.0 / 7.10.0), for any future look:
- `Json @default("{}")` / `@default("[]")` render unquoted in SQLite DDL, and both
  `migrate diff` and `db push` fail. swarmy has ~20 of these defaults.
- `BigInt @id @default(autoincrement())` becomes `BIGINT PRIMARY KEY`, which is not
  SQLite's rowid alias, so ids are probably not auto-filled (unconfirmed at runtime).
