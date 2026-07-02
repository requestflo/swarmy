# Platform buildout manifest — full wishlist delivery

> Coordination contract for the 26 vertical feature slices that turn swarmy into a
> full self-hosted cloud platform. Every implementer MUST read
> `.claude/skills/add-feature-slice/SKILL.md` and
> `.claude/skills/docker-native-storage/SKILL.md` first; UI work additionally reads
> `.claude/skills/hot-signal-design/SKILL.md` and `.claude/skills/react-components/SKILL.md`.
>
> **Golden rule of this buildout:** the spine (schema, protocol messages, service/router/
> worker/route/demo stubs, all central registrations) is created FIRST in one commit.
> Feature slices then only fill in the bodies of files they own — they never edit
> `root.ts`, `workers/index.ts`, `protocol/index.ts`, `messages.ts`, `hub/types.ts`,
> `registry.ts` (demo), `destinations.ts`, or `schema.prisma`. If a slice needs a change
> to a shared file, it is a spine bug — fix the spine, not ad-hoc edits.

## Shared machinery (already in the tree — REUSE, do not reinvent)

- **Agent dispatch**: `ctx.hub.dispatch(nodeId, cmd, payload)`; command names ↔ protocol
  types in `packages/trpc/src/hub/types.ts` `COMMAND_PROTOCOL_TYPE`.
- **Exec in a running container**: command `exec` (`ExecCommandMsg`) — the universal
  lever for `redis-cli`, `psql`, `pg_ctl promote`, etc.
- **One-shot utility container**: NEW command `container.runOnce` (spine) — run an
  image with cmd/env/binds, wait, return `{ exitCode, output }`. Modeled on the sidecar
  containers in `apps/agent/src/handlers/backup.ts`. Use for trivy, cosign, wal-g,
  drills, scheduled jobs that specify an image.
- **Service deploy**: `service.deploy` with a `ServiceSpec` (see `stack.service.ts`,
  `manageddb.service.ts`). One-shot swarm jobs: restartPolicy none + poll + remove.
- **Labels**: write via `service.updateLabels`; read via `ctx.hub.liveInventory(orgId)`
  → `buildInventory` (`packages/core/src/inventory.ts`). JSON-in-one-label for
  structured values.
- **Vault**: `encryptSecret`/`decryptSecret` in `packages/core/src/crypto.ts` for any
  provider token/credential stored in a DB row.
- **Audit**: `writeAudit` (`packages/trpc/src/services/audit.service.ts`) on every mutation.
- **Backups**: restic spine — `backups.service.ts`, `BackupTarget`, agent `backup.ts`.
- **Managed-service pattern**: `manageddb.service.ts` + `manageddb-reconcile.ts` is THE
  template for Redis/search/vector managed services (labels `swarmy.db.*` → mirror).
- **ClickHouse queries**: `observability-query.ts` (parameterized SQL, org-scoped).
- **Outbound HTTP with retry**: `webhooks-out.service.ts` + `webhook-dispatch.ts` worker.
- **Errors**: helpers in `packages/trpc/src/errors.ts`. Inputs: `packages/core/src/inputs.ts`.
  Views: `packages/core/src/views.ts`.
- **Demo mode**: every feature MUST add demo resolvers (file pre-created by spine under
  `apps/app/src/demo/resolvers/`) with seeded, realistic data — this is how the UI is
  reviewed without a swarm.

## Spine additions

### New agent protocol commands (packages/core/src/protocol/swarmres.ts + messages.ts + hub/types.ts + agent executor + handlers)

| CommandName | protocol type | payload |
|---|---|---|
| `secret.create` | `secretCreate` | { name, dataB64, labels? } |
| `secret.remove` | `secretRemove` | { name } |
| `secret.list` | `secretList` | {} → [{ id, name, createdAt, labels }] |
| `config.create` | `configCreate` | { name, dataB64, labels? } |
| `config.remove` | `configRemove` | { name } |
| `config.list` | `configList` | {} → [{ id, name, createdAt, labels }] |
| `config.inspect` | `configInspect` | { name } → { name, dataB64, labels, createdAt } |
| `container.runOnce` | `runOnce` | { image, cmd?, entrypoint?, env?, binds?, networks?, timeoutMs?, pull? } → { exitCode, output (tail ≤64KB) } |

Agent implementation: `apps/agent/src/handlers/swarmres.ts` (secrets/configs via the
`@swarmy/core/docker` wrapper) and `runOnce` generalizing the sidecar-run helper in
`handlers/backup.ts`.

### New Prisma models (packages/db/prisma/schema.prisma — all org-scoped `orgId` + `org` relation)

Alerting/incidents: `NotificationChannel` (kind email|slack|teams|webhook, configEnc),
`AlertRule` (signal, selectorJson, threshold, forSeconds, channelIds, enabled, isDefault),
`AlertEvent` (ruleId?, signal, severity, resource, message, status firing|resolved, firedAt, resolvedAt).
`Incident` (title, status open|resolved, severity, openedAt, resolvedAt, summary),
`IncidentEvent` (incidentId, at, kind, message, meta Json).
Status pages: `StatusPage` (slug unique, title, domain?, componentsJson, showUptime, showIncidents, enabled),
`UptimeSample` (pageId, componentKey, at, status up|degraded|down) — retention-pruned.
Jobs/workflows: `ScheduledJob` (name, schedule cron, kind image|service-exec, image?, serviceRef?, command Json, envJson, runOnJson, timeoutMs, retries, alertOnFailure, enabled, lastRunAt),
`JobRun` (jobId, startedAt, finishedAt?, status running|succeeded|failed|timeout, exitCode?, outputTail, attempt).
`WorkflowDef` (name, version, stepsJson, enabled), `WorkflowRun` (defId, status running|waiting-approval|succeeded|failed|cancelled, cursor, stateJson, startedAt, finishedAt?),
`WorkflowStepRun` (runId, index, name, kind, status, startedAt?, finishedAt?, outputJson?, error?).
Webhook gateway: `InboundEndpoint` (name, slug unique-per-org, verifyKind none|hmac|github|stripe, verifySecretEnc?, targetKind queue|forward, targetJson, retentionDays),
`InboundDelivery` (endpointId, receivedAt, headersJson, bodyText (≤256KB), verifyOk, status pending|delivered|failed|dead, attempts, nextAttemptAt?, lastError?).
Deploy safety: `Release` (stackName, composeSource, imagesJson, actor, strategyJson, status deploying|healthy|failed|rolled-back|superseded, healthGateJson?, createdAt, notes?).
Registry policy: `ImageScan` (imageRef, digest, scannedAt, scanner, criticalCount, highCount, mediumCount, lowCount, reportJson, status passed|failed|error). Extend `RegistryConfig` with requireSignedImages Boolean, blockCriticalCves Boolean, cosignPublicKey?, cosignPrivateKeyEnc?.
Governance singletons (one-per-org, `IngressConfig` pattern): `ExposureConfig` (rulesJson, enforce Boolean), `GuardrailConfig` (rulesJson, productionSafetyMode Boolean).
Notifications: `NotificationConfig` (one-per-org; provider smtp|resend|postmark|mailgun, configEnc, fromAddress), `NotificationTemplate` (name, subject, bodyHtml, bodyText), `NotificationDelivery` (channel, to, subject, status queued|sent|failed|bounced, providerId?, error?, meta Json, createdAt).
AI: `AiProviderConfig` (one-per-org; providersJson w/ encrypted keys via configEnc), `AiVirtualKey` (name, keyHash, appRef?, limitsJson, disabled), `AiUsage` (keyId, at, provider, model, inTokens, outTokens, costMicros, latencyMs, status, cacheHit) , `AiRequestLog` (keyId, at, model, promptRedacted?, meta Json) — behind an audit toggle.
Previews: no model — preview stacks are Docker-truth (`swarmy.preview.*` stack labels); GitRepo gains `previewsJson` column (enable, baseDomain, ttlHours, teardownOnClose).

**Docker-truth (NO models):** managed cache/search/vector cluster state (`swarmy.cache.*`,
`swarmy.search.*`, `swarmy.vector.*` labels), queue definitions (`swarmy.queues` JSON label
on the worker service), DB backup schedule (`swarmy.db.backup.*` labels), deploy strategy
(`swarmy.deploy.*` stack labels), node cost (`swarmy.node.cost` node label), secret/config
families (labels ON the Docker objects: `swarmy.secret.family`, `swarmy.secret.version`).

### New tRPC routers (packages/trpc/src/routers/*, mounted in root.ts by spine)

`cache` (managedCacheRouter), `buckets` (objectStorageRouter), `queues`, `jobs`,
`workflows` (workflowEngineRouter), `inboundWebhooks`, `alerts`, `incidents`,
`statusPages`, `releases`, `registryPolicy`, `previews`, `secretsMgr` → key `secrets`,
`configsMgr` → key `configs`, `exposure`, `guardrails`, `auditLog` → key `audit`,
`cost`, `resilience`, `blueprints`, `search` (managedSearchRouter), `vector`
(vectorStoreRouter), `ai` (aiGatewayRouter), `notifications`.

Each has `src/services/<name>.service.ts`. Admission pipeline:
`src/services/admission.service.ts` (spine) statically imports three evaluators —
`admission-exposure.ts` (E3), `admission-guardrails.ts` (E4), `admission-images.ts` (D3)
— each `(ctx, intent) => Violation[]`; deploy paths call `evaluateAdmission` and refuse
on violations unless `override: true` (override is audited). Health narrative:
`src/services/health-summary.ts` (C2) consumed by stacks/status/alerts.

### New workers (apps/api/src/workers/*, registered by spine)

`cache-reconcile`, `search-reconcile`, `vector-reconcile` (mirror manageddb-reconcile),
`queue-reconcile` (depth stats + scale rules), `job-scheduler` (cron → one-shot runs),
`workflow-runner` (advance WorkflowRun state machines), `inbound-webhook-dispatch`
(deliver/retry/replay), `alert-evaluator` (signals → AlertEvent → notify; also samples
UptimeSample + auto-opens/resolves Incidents), `deploy-safety` (health gates, canary
watch, promote/rollback), `preview-reconcile` (TTL/teardown), `notification-dispatch`
(NotificationDelivery queue), `exposure-audit` (stamp violations → alert events).

### Dashboard routes (apps/app/src/routes/_authed/*, stubs by spine)

`data.tsx` (Data services home: DB/cache/search/vector/buckets tabs or cards),
`queues.tsx`, `jobs.tsx`, `workflows.tsx`, `workflows.$runId.tsx`, `webhooks.tsx`
(inbound + outbound), `alerts.tsx`, `incidents.tsx`, `incidents.$incidentId.tsx`,
`status-pages.tsx`, `releases.tsx`, `secrets.tsx`, `configs.tsx`, `exposure.tsx`,
`governance.tsx` (guardrails), `audit.tsx`, `cost.tsx`, `resilience.tsx`,
`blueprints.tsx`, `ai.tsx`, `settings.notifications.tsx`, plus public unauth'd
`/s.$slug.tsx` (status page) outside `_authed`.

Components live under `apps/app/src/components/<feature>/*` — one folder per feature,
owned exclusively by that slice.

### Demo resolver stubs (apps/app/src/demo/resolvers/*)

One file per feature (spine-registered in `registry.ts`): `cache.ts`, `buckets.ts`,
`queues.ts`, `jobs.ts`, `workflows.ts`, `webhookgw.ts`, `alerts.ts`, `incidents.ts`,
`statuspages.ts`, `releases.ts`, `registrypolicy.ts`, `previews.ts`, `secretsmgr.ts`,
`configsmgr.ts`, `exposure.ts`, `guardrails.ts`, `auditlog.ts`, `cost.ts`,
`resilience.ts`, `blueprints.ts`, `searchsvc.ts`, `vector.ts`, `ai.ts`, `notify.ts`.

## The 26 slices (ownership = listed files + their feature's components/demo file)

**A1 dbbackup-fix** — replace `apps/app/src/components/stacks/managed-db-trpc.ts` usage
with real typed `trpc.dbBackups.*`; align enums to `packages/core/src/protocol/dbBackup.ts`;
add `overview` + `getSchedule`/`setSchedule` to `dbBackup.service.ts`/`routers/dbBackup.ts`
(schedule = `swarmy.db.backup.schedule` JSON label on the cluster primary; scheduler tick
added to `manageddb-reconcile` is OWNED BY A2 — A1 exposes `runDueDbBackups()` from
`dbBackup.service.ts` and A2 calls it). Owns: dbBackup.service.ts, routers/dbBackup.ts,
components/stacks/db-backup-*.tsx, db-restore-*.tsx, managed-db-trpc.ts (delete), demo `data.ts` db-backup keys.

**A2 pitr-ha** — WAL archiving: when `swarmy.db.backup.pitr` label set, manageddb
reconcile adds archive volume + `archive_command='test ! -f /wal-archive/%f && cp %p /wal-archive/%f'`
(bitnami `POSTGRESQL_EXTRA_FLAGS`/conf) + a wal-shipper sidecar service (wal-g image,
loop `wal-g wal-push`) per cluster; lag telemetry: reconcile execs
`psql -c "SELECT pg_wal_lsn_diff(...)"` on replicas → stamps `swarmy.db.lag.<member>` +
`swarmy.db.leader` labels → surfaced in `DbClusterView` + db-cluster-panel; failover
promotion: reconcile detects dead primary (grace window) → picks lowest-lag replica →
exec `pg_ctl promote` → flip member-role labels + repoint replicas → incident event +
alert. Owns: manageddb.service.ts, manageddb-reconcile.ts, components/stacks/db-cluster-panel.tsx
(lag/leader display), protocol dbBackup.ts additions if needed.

**A3 managed-cache** — `cache.service.ts` mirroring manageddb: engines valkey (default,
`valkey/valkey:8`) | redis (`bitnami/redis:7.4`); topologies single | replica | sentinel
(`bitnami/redis-sentinel` x3); labels `swarmy.cache.*` (cluster, role, memoryMb,
regions); memoryMb → maxmemory + swarm resource limit; private-only (no ports; attach
network); password generated → Docker secret; `attachToService` injects `REDIS_URL` (env
w/ secret ref) mirroring manageddb `injectConnection`; snapshot backup = exec `BGSAVE`
(via `redis-cli`) + `backup.run` on the data volume; restore = stop/restore volume/start.
Stats (`INFO` via exec) for UI + queue-reconcile. Worker `cache-reconcile`. UI on Data
services page: create-cache wizard (mode/memory/replicas/regions/attach), cluster panel.

**A4 object-storage** — extend Garage admin client (`replicatedStore.service` /
`garage-render.ts` neighborhood) with bucket CRUD, key CRUD, per-key bucket permissions,
quotas, usage stats (admin API v1: `/v1/bucket`, `/v1/key`); `buckets.service.ts` +
router; `attachToService` injects `S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID` env +
`S3_SECRET_ACCESS_KEY` Docker secret. UI: Buckets tab on Data page (list, create,
keys, attach, usage, public/private toggle→alert if public).

**B1 queues** — queue defs in `swarmy.queues` JSON label on the WORKER service:
`[{name, cacheCluster, convention: bullmq|list, scalePerJobs, minWorkers, maxWorkers,
retries, dlq}]`. `queues.service.ts`: CRUD (label writes), stats via exec `redis-cli`
against the cache cluster (BullMQ key conventions `bull:<q>:wait/active/failed` +
LLEN for raw lists), actions: retry-failed, drain, requeue-DLQ. Worker
`queue-reconcile`: poll depths → scale worker service between min/max by scalePerJobs
(`service.scale`), stamp last-known stats into a `swarmy.queues.stats` label (cheap
history for UI). UI: Queues page — table (depth, active, failed, workers), attach
wizard, scale-rule editor, DLQ view.

**B2 jobs** — `ScheduledJob`/`JobRun` models. `jobs.service.ts`: CRUD + runNow + runs
list + cancel. Worker `job-scheduler`: cron eval (reuse/extend
`packages/trpc/src/services/schedule.ts` — add real 5-field cron parse there if
missing), fire → kind image: `container.runOnce` on a selected node (runOnJson
constraints) capturing output; kind service-exec: `exec` in the service's container;
timeout, retries, JobRun rows, `alertOnFailure` → AlertEvent via alerts helper. UI:
Jobs page — list w/ next-run, editor (cron helper presets), run history + output drawer.

**B3 workflow-engine** — `WorkflowDef/WorkflowRun/WorkflowStepRun`. Steps (sequential
v1): `container` (runOnce), `service-exec`, `webhook` (POST w/ retries), `approval`
(waits; approve/reject mutation, audited), `delay`. `workflows.service.ts`: def CRUD
(versioned), trigger (manual + tRPC + from inbound endpoint target), run
inspect/cancel/approve. Worker `workflow-runner`: advances runs, per-step timeout/retry,
persists cursor/state. UI: Workflows — def builder (ordered step list editor), runs
table, run detail timeline w/ per-step status/output, approval buttons.

**B4 webhook-gateway** — `InboundEndpoint/InboundDelivery`. Public receiver on the api:
`apps/api/src/inbound-hooks.ts` route `POST /hooks/i/<org>/<slug>` (mounted by spine in
`apps/api/src/index.ts`): verify (hmac/github/stripe), persist delivery, 202. Worker
`inbound-webhook-dispatch`: target queue → RPUSH/BullMQ-add via exec on cache cluster;
target forward → POST to service URL (overlay-reachable via... controller can't reach
overlay: forward happens through `container.runOnce` curl on a node OR to a public URL —
v1: forward only to `http(s)://` URLs the controller can reach + queue targets for
in-cluster). Retries w/ backoff, dead after N, replay + inspect + DLQ list in service.
UI: Webhooks page, Inbound tab: endpoints CRUD (shows public URL), deliveries w/ payload
inspector, replay/dead-letter actions; Outbound tab embeds existing webhooksOut UI.

**C1 logs** — `observability-query.ts`: add `buildLogsQuery` (otel_logs: time range,
serviceName, severity, body ILIKE, traceId join) + service fn + router proc
(`observability.logs`); UI: Logs panel on observability page (filter bar, virtualized
list, severity chips, link trace↔logs); per-service logs tab reusing it. Owns
observability.service.ts additions, components/observability/logs-*.

**C2 health-map** — `health-summary.ts`: compose per-stack/service narrative from live
inventory + service status + RED metrics (observability-query summary) + `swarmy.db.lag.*`
+ queue stats label + collector/store state → `{status, reasons[]}`. Service-map:
`buildServiceMapQuery` from otel_traces client/server span pairs → nodes+edges; UI:
Service map panel (react-flow, reuse canvas idioms) + reasons on stack overview +
observability hero. Router procs under `observability.map`/`observability.health`.

**C3 alerts** — models above. `alerts.service.ts`: channels CRUD (config vault-encrypted,
test-send), rules CRUD, event list/ack, `fireEvent()` helper (dedupe by rule+resource,
for-duration) exported for other slices (B2, E3, A2…). Default rule set seeded on first
`list` (node-offline, service-down, db-degraded, db-failover, backup-failed,
cert-expiry<14d, disk>80%, queue-depth, error-rate>5%, store-unreachable). Worker
`alert-evaluator`: evaluates signals from hub inventory + node stats + manageddb labels +
backup results + ClickHouse RED + cert expiry (ingress service TLS probe via runOnce
`openssl s_client`? v1: caddy cert info via admin API if reachable, else skip) →
fire/resolve; sends via `notifications.service.send()` (F6) + slack/teams/webhook direct
fetch; also writes UptimeSample per status-page component + auto-open/resolve Incident
(via incidents helper). UI: Alerts page — rules table w/ toggle, channel manager,
firing/resolved event feed; bell badge in shell header.

**C4 incidents** — `incidents.service.ts`: open/resolve/append (helper
`recordIncidentEvent` used by alert-evaluator, A2 promotion, geodns-reconcile is NOT
edited — geo events arrive via alert signals), manual notes, list/detail. UI: Incidents
page — open/past lists, detail timeline (the 14:01→14:05 story), post-mortem notes.
Status page consumes via service fn `publicIncidents(pageId)`.

**C5 status-pages** — models above. `statusPages.service.ts`: CRUD, component picker
(services/clusters/regions), public snapshot fn `publicStatus(slug)` (component status
from health-summary, uptime history from UptimeSample, incidents from C4) — exposed
UNAUTHENTICATED via `apps/api/src/status-public.ts` (spine-mounted) `GET /status/<slug>.json`
+ the SPA public route `/s/$slug` rendering it (no auth, fetches the JSON). Custom
domain: creates an ingress route (ingress-routes-api) pointing host→controller. UI:
Status pages settings (create, pick components, domain, preview link) + the public page
(clean, brandable, uptime bars, incident history).

**D1 releases** — `Release` model. `releases.service.ts` + hooks INSIDE
`stack.service.ts#deployFromCompose` (D1 owns this file's edits): snapshot compose +
resolved images → Release row; post-deploy health gate: `deploy-safety` worker watches
new release for `healthGateJson.windowSec` via health-summary → mark healthy/failed;
auto-rollback if `swarmy.deploy.safety` stack label enables it → redeploy previous
Release compose (audited, incident event). Manual rollback mutation. UI: Releases page +
per-stack panel: history w/ status chips, diff (compose), rollback button, safety
settings editor (health gate window, auto-rollback toggle).

**D2 canary** — strategy in `swarmy.deploy.strategy` stack label
`{type: rolling|canary|bluegreen, trafficPct, durationMin, rollbackOnErrorRatePct}`.
Canary: deploy updated services as `<svc>--canary` alongside stable; ingress weighted
upstreams — extend `packages/ingress/src/render/caddyfile.ts` (D2 owns) with
`lb_policy weighted_round_robin <w1> <w2>` when a route has `canary: {target, weightPct}`
in `swarmy.ingress.routes`; `deploy-safety` worker (shared file with D1 — D1 creates the
worker skeleton with two hook points; D2 fills the canary watcher fn in its own file
`deploy-canary.ts` imported by the worker): watch error-rate (RED metrics; fallback task
health) over window → promote (image swap on stable, remove canary, restore weights) or
rollback. Blue/green: full parallel `<stack>--green` deploy + atomic route flip + old kept
`durationMin` for instant rollback. UI: strategy picker on deploy + release detail
progress (traffic %, error rate, promote/abort buttons).

**D3 image-policy** — on build success (hook exported from `admission-images.ts`, called
by cicd.service — D3 owns a small callout added in cicd.service.ts marked `// D3 hook`):
scan via runOnce `aquasec/trivy:latest image --format json <ref>` on the builder node →
`ImageScan` row; sign via runOnce cosign (`cosign sign --key env://COSIGN_KEY <ref@digest>`,
org keypair generated once, private key vault-encrypted in RegistryConfig); admission
evaluator `admission-images.ts`: requireSignedImages → runOnce `cosign verify` (cache
result per digest), blockCriticalCves → ImageScan lookup. UI: registry panel additions —
per-image scan results (CVE counts, drill-in), policy toggles, org signing key status.

**D4 previews** — GitRepo.previewsJson. Extend webhook parsing in
`apps/api/src/webhooks.ts` (D4 owns additions) for PR opened/synchronize/closed →
`previews.service.ts`: build branch (cicd build path) → deploy stack namespace
`pr<N>-<repo>` with `swarmy.preview.*` labels {repo, pr, branch, createdAt, ttlHours,
url} + ingress route `pr-<N>.<baseDomain>` + generated env secrets; teardown on close +
TTL via `preview-reconcile` worker. List = inventory scan for preview labels. UI:
Previews tab on CI page: cards (PR, branch, URL, age, destroy), repo preview settings.

**E1 secrets-mgr** — `secretsMgr.service.ts` over new agent commands: list (families =
group by `swarmy.secret.family` label, version = `swarmy.secret.version`), create
(family v1), rotate (create v(n+1) → find consumers in live inventory (service spec
secret refs — extend `SwarmServiceInfo`/inventory to carry secret+config refs; owned by
SPINE) → `service.deploy` update each consumer to new ref → optional remove old),
usage map, delete (blocked if in use). Values are write-only. Env-templates: predefined
name suggestions. UI: Secrets page — family table (versions, last rotated, used-by),
create/rotate dialogs w/ multiline value, usage drill-in, danger delete.

**E2 configs-mgr** — same shape via config.* commands + `config.inspect` for content;
edit = create v(n+1) + preview which services restart (usage map) + apply (update
consumers) + rollback (repoint to previous version); diff view (old/new content). UI:
Configs page mirroring Secrets with content editor + diff + restart preview modal.

**E3 exposure** — `exposure.service.ts`: audit = inventory scan → per service: published
ports (mode), ingress routes/domains (labels), managed-data flag (swarmy.db./cache./search.
labels), verdict public|private|protected; `ExposureConfig.rulesJson` defaults: forbid
public ports on managed data services, forbid publicUdp, warn on any new published port.
`admission-exposure.ts` evaluator enforces at deploy; `exposure-audit` worker stamps
violations → alert events. UI: Exposure page — the table from the wishlist
(app.example.com public / postgres private…), rules editor, violations feed w/ fix hints.

**E4 guardrails** — `GuardrailConfig.rulesJson` rules: noLatestTagInProd, minDbReplicas,
requireBackupPolicy (BackupSchedule or db backup schedule exists), requireSignedImages
(delegates to D3), requireHealthcheck, requireResourceLimits, productionSafetyMode master
toggle (stack label `swarmy.env=production` marks prod stacks; also settable in UI).
`admission-guardrails.ts` evaluator; violations block deploy with per-violation override
(audited). UI: Governance page — safety-mode master switch, rule toggles w/ plain-English
descriptions, recent blocked/overridden actions.

**E5 audit-pack** — `auditLog.service.ts` (query: actor/action/resource/date filters,
cursor pagination) + export (JSON/CSV via REST `packages/api-rest` route — owns new file
`routes/audit.ts`; spine mounts) + retention setting. Canned questions as quick filters
("who accessed production?" = terminal sessions + node-shell, "who changed secrets?",
"who deployed?"). UI: Audit page — filter bar, timeline table, export buttons, canned
queries, per-row detail drawer.

**F1 cost** — node cost label `swarmy.node.cost` (monthly USD, set via nodes UI —
`cost.service.ts` writes node label through `node.update`… node labels via
`node.update` command exists). Utilization from gateway node stats + MetricSample;
`cost.service.ts`: per-node (cost, cpu/mem util), per-stack estimated share (by
reservations else usage), idle services (avg cpu < 2% over 7d), oversized nodes,
storage (Garage stats + volume sizes if available). Recommendations rule-list. UI: Cost
page — totals, per-node table w/ cost editor, per-stack breakdown, recommendations feed.

**F2 resilience** — `resilience.service.ts`: checks (pure, from inventory/labels/models):
single-replica services, cache no-replica, db topology risk, storage replication factor,
backup recency + last restore test, ingress single-node, geodns single-region, controller
backup recency → score + problems w/ severity + fix links. Safe drills (each confirm +
audit): db-failover drill (A2 promotion on a replica), restore drill (dbBackups restore
`clone-to-new-cluster` + verify `SELECT 1` via exec + drop, records result for score),
backup-verify (restic check via runOnce). UI: Resilience page — score ring, problems
list, drill buttons w/ confirm dialogs + history.

**F3 blueprints** — static catalog `blueprints/catalog.ts` (in trpc services dir):
next-app, node-api, static-site, wordpress, n8n, directus, meilisearch-app, worker+queue,
monitoring — each a parameterized generator producing swarmy-native resources (managed
db/cache provision + bucket + secrets + ingress route + backup schedule + compose) via
existing services. `blueprints.service.ts`: list, plan (dry-run resource preview),
deploy. UI: Blueprints gallery — cards, wizard (name/domain/size), plan preview
("will create: DB cluster, bucket, 2 secrets, route"), deploy → progress.

**F4 managed-search** — mirror A3 for meilisearch (`getmeili/meilisearch:v1.12`) |
typesense (`typesense/typesense:27.1`): labels `swarmy.search.*`, single-node + volume,
master key Docker secret, private-only, attach (MEILI_HOST/MEILI_MASTER_KEY or
TYPESENSE_*), backup = engine dump via exec + volume backup, worker `search-reconcile`.
UI: Search tab on Data page (create, attach, key reveal-once, backup).

**F5 ai** — vector: mirror A3 for qdrant (`qdrant/qdrant:v1.12`) labels `swarmy.vector.*`
+ pgvector option (exec `CREATE EXTENSION IF NOT EXISTS vector` on a managed PG +
mark label) — worker `vector-reconcile`; attach injects QDRANT_URL/KEY. Gateway:
`apps/api/src/ai-gateway.ts` (spine-mounted) `POST /ai/v1/messages|chat/completions|embeddings`
→ auth via `x-swarmy-ai-key` (AiVirtualKey hash) → route by model prefix to provider
(anthropic/openai/openrouter/custom base URL; creds from AiProviderConfig vault) →
enforce limits (budget/RPM from AiUsage rolling) → log AiUsage (+AiRequestLog if audit
on) → optional exact-match cache (hash of body, TTL). `ai.service.ts`: providers CRUD,
keys mint/revoke (secret shown once), usage/cost queries, logs. Attach injects
AI_GATEWAY_URL + key secret. UI: AI page — providers config, keys table, usage & cost
charts (per key/model/day), request log, cache toggle.

**F6 notifications** — `notifications.service.ts`: `send({to, subject, template|body})`
→ NotificationDelivery row; worker `notification-dispatch` sends via provider
(resend/postmark/mailgun REST via fetch; smtp via nodemailer — dep pre-added) with
retry/backoff; templates CRUD; test-send; bounce webhooks land on an auto-created
InboundEndpoint (B4) target `notifications.bounce` handler. Exposed to apps: REST
`POST /v1/notify` (api-rest route file `routes/notify.ts`) with API key. UI:
settings/notifications — provider config (encrypted), from-address, templates editor,
delivery log w/ status, test send.

## Wave G — UI overhaul (after features integrate)

Goals: everything discoverable without ⌘K; first-run clarity; consistent anatomy.
- Navigation: grouped desktop sidenav per hot-signal-design shell spec (navy rail):
  Home, Stacks, Data (DB/Cache/Search/Vector/Buckets), Delivery (CI, Releases,
  Previews, Registry), Operations (Observability, Alerts, Incidents, Jobs, Queues,
  Workflows, Webhooks, Status pages), Network (Ingress, Mesh, Geo DNS, Exposure),
  Protection (Backups, DR, Resilience), Governance (Secrets, Configs, Policies,
  Guardrails, Audit, Cost), Settings. Keep ⌘K palette + planes as accelerators.
  `destinations.ts` stays the single registry (extend groups).
- Home dashboard: estate health (health-summary), firing alerts, open incidents, recent
  releases/builds, onboarding checklist for empty estates (add node → deploy → domain →
  backups → alerts).
- Every page: consistent header (title, one-line explainer, primary action), empty state
  that teaches (what/why/CTA), loading skeletons, error states with retry.
- Global “+ Create” menu (service, stack, database, cache, bucket, queue, job, workflow,
  endpoint, status page, blueprint).
- Contextual cross-links (service → its logs/metrics/routes/secrets/queues).
- Playwright demo-mode screenshot sweep of every route as review artifact.

## Verification bar (every slice)

- `bun typecheck` green from repo root; `bun --filter @swarmy/app build` green.
- Unit tests for pure logic (schedule math, admission rules, render fns, parsers) —
  colocated `*.test.ts` run by `bun test`.
- Demo resolvers seeded so the page renders meaningful data in demo mode.
- Every mutation org-scoped + `writeAudit`.
- No new deps beyond pre-added (`nodemailer`); no controller→overlay network calls
  (agent dispatch only); secrets never persisted plaintext or returned to clients.
