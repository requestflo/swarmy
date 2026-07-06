---
name: observability-otel
description: Invariants, contracts, and file map for swarmy's per-stack OpenTelemetry suite — the OTEL_* env/label injection on deploy, the one self-deployed OTel Collector + ClickHouse store (collector owns the schema), the org-scoped ClickHouse read builders (traces/service-map/metrics/logs), the plain-words health narrative, and the alerts→incidents→status-page spine. Load before touching packages/trpc/src/services/{otel-injection,observability-*,observability.service,health-summary,alerts*,incidents*,statusPages*}.ts, routers/{observability,alerts,incidents,statusPages,metrics}.ts, schema/{observability,alerts}.prisma, apps/api/src/workers/{observability-reconcile,alert-evaluator}.ts, apps/api/src/status-public.ts, or the observability/status UI. Product rationale lives in docs/product/observability.md.
---

# Observability: inject env → collector → ClickHouse → swarmy's own UI

Read `docs/product/observability.md` for WHY it must feel like flipping a switch.
This skill is the HOW: the invariants every change must keep, and where
everything lives. Enabling a stack is a deploy-time slice, so for the broader
db→protocol→service→router→UI shape see `skill("add-feature-slice")`.

## Invariants (violating any of these is a bug, not a style choice)

1. **The per-stack opt-in is a Docker LABEL, never a DB column.**
   `swarmy.otel.enabled` (`OTEL_ENABLED_LABEL`) is stamped on the stack's
   services and re-stamped by `injectOtel` on every injected deploy;
   `stackTelemetryEnabled(ctx, stack)` reads it back from the LIVE inventory. If
   you add a `Stack.telemetryEnabled`-style column, stop — see the
   `docker-native-storage` skill.
2. **Injection adds only env + labels + the overlay join — never image, command,
   or behaviour.** `injectOtel` sets `OTEL_EXPORTER_OTLP_ENDPOINT`
   (`http://swarmy-otel-collector:4317`), `OTEL_SERVICE_NAME`,
   `OTEL_RESOURCE_ATTRIBUTES` (`swarmy.org_id/stack/service` + environment),
   `OTEL_TRACES_SAMPLER=parentbased_always_on`, labels (`swarmy.otel.enabled`,
   `swarmy.telemetry=on`, `swarmy.stack`, `swarmy.service`), and joins the
   `swarmy` overlay. For an app that ignores `OTEL_*` it must be a strict no-op —
   the stack runs byte-identically with telemetry off.
3. **Never overwrite a user-set `OTEL_*` value.** If the spec already sets an env
   key, injection leaves it — point-at-your-own-collector wins. Fill absent keys
   only.
4. **The three-state override is `service > stack`.** `augmentSpecForService`
   resolves `serviceOverride === true → on`, `=== false → off`, else
   `stackEnabled`. `augmentSpecsForStack` returns the ORIGINAL array unchanged
   when `telemetryEnabled` is false (identity, so opt-out is a clean revert).
   Both run inside the existing deploy path (`stack.service.ts` calls
   `augmentSpecsForStack` before dispatch).
5. **ONE store, ONE collector, deployed via the EXISTING `service.deploy` path.**
   No new `CommandName`, no new protocol message. `clickhouseServiceSpec` +
   `collectorServiceSpec` are plain `ServiceSpec`s dispatched through the same
   deploy path apps use, grouped under the `swarmy-system` stack
   (`MANAGED_LABELS`). Enabling for the first org deploys them; the suite has zero
   footprint when nobody has opted in.
6. **The collector OWNS the ClickHouse schema.** `renderCollectorConfig` runs the
   ClickHouse exporter with `create_schema: true` and `ttl: <retentionDays*24>h`,
   so the exporter's DDL is the source of truth for `otel_traces`/`otel_logs`/
   metrics tables. `renderClickhouseInitSql` only ensures the database exists —
   never hand-roll table DDL that could drift from the writer's.
7. **The controller is the ONLY reader of ClickHouse, and EVERY query is
   org-scoped at the storage layer.** All SQL is built in the pure
   `observability-query.ts`/`observability-map.ts` builders, constrained by
   `ResourceAttributes['swarmy.org_id'] = lit(orgId)` on BOTH join sides, every
   string routed through `lit()` (single-quote escape), every int `clampInt`'d.
   Users never touch raw ClickHouse; they get audited tRPC procedures.
8. **Telemetry data lives in ClickHouse; the DB owns only control state + fired
   history.** Postgres holds `ObservabilityConfig`/`ObservabilityStoreState` and
   the alerting spine — never spans/metrics/logs. Retention is a ClickHouse `TTL`,
   not a swarmy delete loop; `observability-reconcile.ts` OBSERVES (probes `/ping`
   + `system.parts` footprint), it does not delete.
9. **Health is composed on read, never stored.** `health-summary.ts` recomposes
   the plain-words narrative each call from live task signals, DB replica lag,
   queue depth, and RED rows — with an explicit collector/store-reachable signal
   so a blind check reads "checks are blind", never a false green.
10. **The service map is derived from spans, not declared.** Edges are
    client/server span-kind pairs (`CALLER_KINDS` parenting `ENTRY_KINDS` across a
    different `ServiceName`); RED is server-side. Degraded tint thresholds
    (`MAP_P95_DEGRADED_MS` 1500, `MAP_ERROR_RATE_DEGRADED` 0.05) mirror the health
    targets — keep them in sync.
11. **Secrets are encrypted; the public status page is unauth and read-only.**
    `NotificationChannel.configEnc` and `ObservabilityConfig.clickhouseDsn` go
    through the vault (`SWARMY_SECRET_KEY`) and are never returned to clients.
    `apps/api/src/status-public.ts` serves `GET /status/<slug>.json` with no auth
    — never add a mutating or org-crossing path to it.

## Contracts between the layers

- **Enable → deploy**: `observability.service.ts#setEnabled` deploys the store +
  collector (via `resolveManagerNode` + the `service.deploy` path) and writes
  `ObservabilityConfig`; `enableForStack` stamps `OTEL_ENABLED_LABEL` on the
  stack's services. No agent code changes — this is the whole point of reusing
  deploy.
- **Deploy → injection**: `stack.service.ts` calls
  `augmentSpecsForStack(specs, { telemetryEnabled, orgId, stack, environment })`
  right before dispatch; per-service overrides come from the service's own label.
- **Collector → ClickHouse**: the exporter writes `otel_traces` etc. with
  `ResourceAttributes` carrying `swarmy.org_id/stack/service`; the read builders
  filter on exactly those keys.
- **Read path**: `routers/observability.ts` procedures (`traces`, `traceDetail`,
  `metricsSeries`, `metricsSummary`, `logs`, `map`, `health`, `getStatus`) → the
  service → the pure builders → ClickHouse HTTP. `getStatus` folds
  `ObservabilityStoreState` + `collectorStatus` into the tab's Running/Reachable
  badges.
- **Signal → alert → incident → status**: `alert-evaluator.ts` worker evaluates
  `AlertRule`s and samples `UptimeSample`; `alerts-fire.ts` raises/resolves
  `AlertEvent` (deduped on rule/signal + `resource`) and notifies channels;
  `incidents-record.ts` opens/updates `Incident` + `IncidentEvent`;
  `statusPages.service.ts` composes the public snapshot (90-day uptime).
- **Result of a fire**: everything is audited via `writeAudit` — fires, resolves,
  overrides, enable/disable.

## File map

| Concern | Where |
|---|---|
| OTEL env/label injection + service override | `packages/trpc/src/services/otel-injection.ts` (`injectOtel`, `augmentSpecForService`, `augmentSpecsForStack`, `OTEL_ENABLED_LABEL`) |
| Managed store + collector `ServiceSpec`s | `packages/trpc/src/services/observability-stack.ts` |
| Collector config + ClickHouse init render (`create_schema`, TTL) | `packages/trpc/src/services/observability-render.ts` |
| Org-scoped ClickHouse SQL: traces/metrics/logs | `packages/trpc/src/services/observability-query.ts` |
| Org-scoped ClickHouse SQL: service map (RED per edge) | `packages/trpc/src/services/observability-map.ts` |
| Enable/read layer (deploy suite, query, status) | `packages/trpc/src/services/observability.service.ts` |
| Plain-words health narrative | `packages/trpc/src/services/health-summary.ts` |
| tRPC router (getConfig/status/traces/…/health) | `packages/trpc/src/routers/observability.ts` |
| Alerts spine | `services/{alerts.service,alerts-fire}.ts` + `routers/alerts.ts` |
| Incidents spine | `services/{incidents.service,incidents-record}.ts` + `routers/incidents.ts` |
| Status pages (+ public snapshot) | `services/statusPages.service.ts`, `routers/statusPages.ts`, `apps/api/src/status-public.ts` |
| Store-state reconcile (probe reachability/footprint) | `apps/api/src/workers/observability-reconcile.ts` |
| Alert eval + uptime sampling worker | `apps/api/src/workers/alert-evaluator.ts` |
| Prisma: config/store-state + alerts/incidents/status | `packages/db/prisma/schema/{observability,alerts}.prisma` |
| Trace UI: waterfall/map/metrics/logs panels | `apps/app/src/components/observability/*` |
| Top-level nav + trace detail routes | `apps/app/src/routes/_authed/observability{,.$traceId}.tsx` |
| Alerts/incidents/status routes + public page | `routes/_authed/{alerts,incidents,status-pages}.tsx`, `routes/s.$slug.tsx` |

## Adding a signal / query (the recipe)

1. **Query builder** (pure, no IO) in `observability-query.ts` or a sibling: take
   `orgId`, apply `ResourceAttributes['swarmy.org_id'] = lit(orgId)`, route every
   string through `lit()`, `clampInt` every number/window. Add a `*Row` interface
   for the JSONEachRow shape.
2. **Service** method in `observability.service.ts`: run the builder over the
   ClickHouse HTTP interface, map rows → a `@swarmy/core` wire view.
3. **Router** procedure in `routers/observability.ts` (`orgProcedure`; mutations
   are `adminProcedure` + audited).
4. **UI** panel in `apps/app/src/components/observability/*` (see
   `skill("hot-signal-design")`).
5. If it feeds health, add a signal to `HealthSignals` in `health-summary.ts` and
   a degraded/info line — with a target constant, so the narrative stays plain
   words with a threshold.

For a NEW managed store option or a NEW reconcile loop, note that convergence is
a worker's job — the store-state probe already lives in
`observability-reconcile.ts` (see `skill("reconcile-workers")`), and it must stay
observe-only (ClickHouse `TTL` owns deletion).

## Operational gotchas

- Injection must never overwrite user `OTEL_*` — the golden test in
  `otel-injection.test.ts` pins both the no-op-when-disabled identity and the
  don't-overwrite rule; keep them green.
- ClickHouse is heavy: keep the suite strictly opt-in (zero footprint when off),
  keep tail sampling + short `TTL` defaults, and surface `diskUsedBytes` in the
  UI so growth is visible before it hurts.
- The collector schema is the writer's — if you touch table shape, change
  `renderCollectorConfig`'s exporter settings, not a hand-rolled `CREATE TABLE`
  in `renderClickhouseInitSql`.
- Never add an unauth or mutating route to `status-public.ts`; the public status
  snapshot is read-only by design.
- Verify: `bun --filter @swarmy/trpc typecheck` and the unit suites
  (`otel-injection`, `observability-query`, `observability-map`, `health-summary`,
  `alerts.service`, `incidents-record`, `statusPages.service` tests).
