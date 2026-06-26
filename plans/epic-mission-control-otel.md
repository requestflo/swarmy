# Epic: Mission control — OpenTelemetry observability (traces + metrics + logs), per-stack opt-in, native Jaeger-style UI

> Status: plan / implementation-ready. Targets the existing swarmy scaffold (Bun + Turborepo, tRPC v11/Hono, Prisma 7/Postgres, agent dial-out WS, pluggable driver/render registries, in-memory snapshot store + `MetricSample` history). Do not redesign the scaffold; this epic plugs into it.

## Problem

Observability on self-hosted PaaS/Swarm tools is almost universally bad: either there's nothing (you're left tailing `docker logs`), or you're told to "just deploy Grafana + Prometheus + Loki + Tempo yourself" — four stateful services, four config languages, scrape configs, retention tuning, and a UI that knows nothing about *your* stacks. That violates swarmy's entire premise ("anyone can just deploy — it has to be that simple").

swarmy already has the *infrastructure* half right: a per-node agent streaming `metrics` frames, an in-memory snapshot ring for live reads, a `MetricSample` history table, and a `metrics` tRPC router with timeseries/overview/live subscription. But that's **resource monitoring only** (node/container CPU/mem/net/disk). It has no concept of:

- **Distributed traces** — where a request actually spent its time across services.
- **Application metrics** — RED/USE, request rates, p95 latency, error ratios, custom business metrics — i.e. anything emitted by the *app*, not scraped from cgroups.
- **Structured, queryable logs** correlated to traces and services (today logs are an ephemeral `streamLogs` tail, never stored, never searchable).

We want a **mission-control observability suite**: opt any stack into traces/metrics/logs with one toggle, and view them in swarmy's *own* UI — a Jaeger-like trace explorer, RED/latency dashboards, and a correlated log search — with traces↔logs↔metrics linked by `trace_id`/`service.name`. It must be per-stack opt-in (off by default, individually disableable, unopinionated: a stack must run identically with or without telemetry), zero-config to turn on, org-scoped, and audited.

The core design questions this epic must answer, and does:
1. **Collector deployment model** — per-node agent capability vs a Swarm service. (Answer: both, agent-per-node + a gateway service, swarmy-managed.)
2. **Backend storage** — Prometheus/Mimir + Tempo/Jaeger + Loki, *or* a ClickHouse-unified store (SigNoz/Uptrace-style). (Answer: **ClickHouse, unified, swarmy-managed — but we own the UI, we do not bundle SigNoz.**)
3. **How per-stack opt-in auto-injects OTel** without the user editing their app.
4. **How data reaches the controller UI**, retention, and **how the in-memory ring + `MetricSample` evolve.**
5. **Embed vs build** the trace UI. (Answer: **build native, thin**, querying ClickHouse — embed Jaeger only as an optional escape hatch.)

Non-goals: profiling/continuous-profiling (Pyroscope) in v1; RUM/browser telemetry; being a general-purpose Grafana replacement for arbitrary external data sources; multi-petabyte scale (target: small/medium swarms, 3–9 nodes, modest trace volume with sampling).

## Recommended approach

Three decisions, each load-bearing.

### Decision 1 — Storage: **ClickHouse, one unified columnar store for traces + logs + metrics** (not the Grafana LGTM stack)

Use a single **ClickHouse** instance/cluster, swarmy-deployed and -managed, as the backend for all three signals. This is the SigNoz/Uptrace architecture, and it's the right one for swarmy's audience.

Why ClickHouse-unified over Prometheus/Mimir + Tempo + Loki:

- **One stateful service to operate, not four.** The LGTM stack means Loki (logs), Tempo (traces), Mimir/Prometheus (metrics), each with its own storage, retention, config, scaling story, plus Grafana to glue them. That is exactly the "deploy four things yourself" burden we're eliminating. ClickHouse is *one* binary, one volume, one retention model (TTL), one query language. SigNoz's whole pitch — and the reason it beats LGTM for small self-hosters — is "single columnar datastore = far less operational overhead," and the ClickHouse-backed setup fits in **~1.5GB RAM** to get started, which is viable on a small swarm node. (LGTM's four services each want their own headroom.)
- **Correlation is free and fast.** traces, logs, and metrics in one store joined on `trace_id` / `service.name` / `resource` attributes means "jump from a slow span to its logs to the service's latency chart" is a SQL join, not cross-datasource gymnastics. Loki's logs are not indexed on arbitrary attributes; ClickHouse indexes what we want (duration, status, attributes) for fast trace search — the thing that makes trace UIs feel good.
- **It's already swarmy's trajectory.** We're going to need a real time-series store anyway as `MetricSample` (row-per-node-per-interval in Postgres) hits its ceiling. ClickHouse *is* that store. One store now serves both the existing resource metrics and the new app metrics/traces/logs (see Architecture — the `MetricSample` evolution).
- **OTLP-native ingestion path is well-trodden.** The OTel Collector's ClickHouse exporter writes OTLP traces/logs/metrics directly into ClickHouse with a known-good schema; we adopt that schema so we inherit a battle-tested table layout (and Jaeger-compat tables for the optional embed escape hatch).

Why not the LGTM stack: it's the "powerful but you assemble it" path — fine for a platform team, wrong for "anyone can just deploy." Why not **bundle SigNoz or Uptrace wholesale**: tempting (they're MIT/Apache and ClickHouse-native) but they each ship *their own* auth, multi-tenancy, dashboards, alerting, and UI — duplicating systems swarmy already owns (Better Auth + org plugin, RBAC, tRPC, the dashboard SPA, audit log). Bundling one would fork swarmy's identity/permission model and give users two UIs with two login systems. **So: take the proven pieces (ClickHouse + the OTel Collector ClickHouse schema) and build the thin UI ourselves on top, inside swarmy's existing org-scoped, audited, single-pane shell.** This is the same move the volumes-DR epic makes (use restic the tool, own the UX). Their MIT license makes lifting the *schema/queries* clean; we are not redistributing their app.

ClickHouse is itself just another Swarm service swarmy stands up and manages (a new `ObservabilityStore` driver, analogous to a storage cluster) — single node by default, with a documented path to a replicated ClickHouse Keeper cluster later. It is **opt-in and individually disableable**: no telemetry enabled ⇒ no ClickHouse deployed ⇒ zero footprint. This honors "pluggable, individually disableable."

### Decision 2 — Collector topology: **per-node agent collector (DaemonSet-equivalent) + a per-swarm gateway collector**, both swarmy-managed

Adopt the OpenTelemetry **agent-to-gateway** pattern, mapped to Swarm:

- **Node collector** = an OTel Collector deployed as a Swarm **`global`** service (one task per node — the Swarm equivalent of a Kubernetes DaemonSet). It is the local OTLP endpoint apps talk to (`http://otel-collector:4317`/`4318` on the swarmy overlay network, reachable on every node), and it scrapes node-local signals (`hostmetrics`, container stdout via `filelog`/the Docker logging driver). Smaller batches, low latency, node-local — the documented role of the agent tier.
- **Gateway collector** = an OTel Collector deployed as a **replicated** service (1–2 tasks) that the node collectors forward to. It owns the expensive cross-cutting concerns: **tail-based sampling** (keep all error/slow traces, sample the boring ones — the single most important knob for keeping trace volume and ClickHouse small), batching for write efficiency, attribute enrichment (stamp `swarmy.org_id`, `swarmy.stack`, `swarmy.service` from Docker labels), and the **ClickHouse exporter**. Then ClickHouse stores it.

Why both tiers rather than "one collector": the node tier must be on every node to be a NAT-free local OTLP target and to read node-local files/metrics; the gateway tier centralizes sampling/enrichment/export so the write path to ClickHouse is batched and consistent and so tail sampling sees whole traces. This is the textbook hybrid and it's what production setups converge on.

**Why a Swarm service, not "fold the collector into the swarmy agent binary":** the swarmy agent is a control-plane component (dials out over WS, executes dockerode commands). The OTel Collector is a high-throughput *data-plane* component with its own scaling, memory, and crash-isolation needs; coupling them would make a collector OOM take down node control. Keep them separate processes. **But the swarmy agent owns the collector's lifecycle** — it deploys/configures/reloads the collector exactly as it does ingress (render config → agent writes files → reload), so from the user's view it's still "swarmy manages it," zero manual collector ops. The collector binary ships in/with the agent image (pinned `otel/opentelemetry-collector-contrib`), or is deployed as a normal Swarm service via the existing `deployService` path.

### Decision 3 — Trace UI: **build a native, thin trace explorer** querying ClickHouse via tRPC; **embed Jaeger only as an optional escape hatch**

Build swarmy's own trace explorer (trace search + waterfall/span detail + service map) as React components in `apps/app`, fed by a `telemetry` tRPC router that queries ClickHouse. Reasons:

- A trace waterfall is a **well-understood, bounded UI** (a list query + a span tree + a flamegraph-ish timeline). It is not a year of work, and building it means it lives *inside* swarmy's shell: same auth, same org scoping, same nav, deep links from a service/deployment straight to its traces, traces↔logs↔metrics cross-links. An embedded Jaeger is a separate app with a separate (or bolted-on) auth story and no knowledge of swarmy's stacks/orgs — it breaks the single-pane promise and the org-scoping/audit guarantees.
- We control the data model and queries, so we get swarmy-native facets (filter by stack, by deployment, by org) that a generic Jaeger UI can't offer.
- **Escape hatch:** because we write the OTel Collector's Jaeger-compatible ClickHouse tables too, advanced users can optionally point a stock Jaeger UI (or Grafana w/ ClickHouse datasource) at the same store. We expose this as an off-by-default "open in Jaeger" deployment, not the default surface. This hedges the build risk: if our native UI lags on some power feature, the raw store is standard and any OTLP/Jaeger/Grafana tool works against it. (We never lock data in.)

For visualization primitives: reuse the existing `@swarmy/ui` chart components (`charts.tsx`, `sparkline`, `metric-card`) for metrics dashboards; build a dedicated `TraceWaterfall` + `SpanDetail` + `ServiceMap` (the only genuinely new UI). Span timeline rendering is a div-based gantt; no heavy dependency required (optionally a small lib for the flamegraph view later).

## Architecture & integration

Everything mirrors existing swarmy patterns: a **pluggable driver/render registry** (like `@swarmy/ingress`) produces **generic render intent** the agent applies; **new wire-protocol message types** carry it; **tRPC routers + a services layer** drive reads/writes; a **worker** in `apps/api` handles retention/rollups; everything is **org-scoped + audited**; live data flows over the **existing dial-out WS + subscription plumbing** with no transport changes.

### New package: `@swarmy/telemetry`

Parallels `@swarmy/ingress` — pure, no IO, produces specs/intent the agent executes; shared Zod types re-exported through `@swarmy/core` so agent + controller share one definition (same convention as `RenderedConfig`).

- **`CollectorRenderer`** — given a per-org/per-swarm telemetry config (which signals enabled, sampling rate, exporter target, per-stack toggles, attribute enrichment rules), render an OTel Collector **`RenderedCollectorConfig`**: the collector YAML (`receivers: otlp/hostmetrics/filelog`, `processors: batch/tail_sampling/resource/transform`, `exporters: clickhouse`), plus the Swarm service specs for the node (`global`) and gateway (`replicated`) collectors, plus the ClickHouse exporter wiring. Pure render → carried to the agent verbatim, applied like ingress.
- **`StoreRenderer`** — render the **ClickHouse** deployment (Swarm service spec + config files + init DDL: traces/logs/metrics tables, materialized views for service/latency rollups, TTLs for retention). Single-node default; cluster (ClickHouse Keeper) later. Mirrors a storage-cluster driver.
- **`OtelInjection`** helper — given a `ServiceSpec` and a resolved telemetry config, return the env vars / labels to inject so the app auto-ships OTLP (see "per-stack opt-in" below).
- **`TraceQuery` / `MetricQuery` / `LogQuery`** builders — typed ClickHouse SQL builders (parameterized) the controller's telemetry service uses. Pure string/param construction, no IO; the controller owns the ClickHouse client.

### Per-stack opt-in: how OTel is auto-injected (the magic)

Opt-in lives at the **stack** (and overridable at the **service**) level. When a stack is telemetry-enabled, `composeToSpecs` / the deploy path runs each `ServiceSpec` through `OtelInjection` before dispatch, adding **only environment + labels** — never changing the image or app code (stays unopinionated; the stack runs identically without swarmy, the env vars are simply no-ops if nothing reads them):

- **Zero-code path (always on when enabled):** inject the OTel SDK env conventions so any OTel-instrumented app auto-exports — `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317` (the node collector on the overlay), `OTEL_SERVICE_NAME=<service>`, `OTEL_RESOURCE_ATTRIBUTES=swarmy.org_id=…,swarmy.stack=…,swarmy.service=…,deployment.environment=…`, `OTEL_TRACES_SAMPLER=parentbased_always_on` (real sampling is tail-based at the gateway). Plus Docker labels (`swarmy.telemetry=on`, `swarmy.stack`, `swarmy.service`) so the `filelog` receiver and the gateway's `resource` processor can stamp every log line and metric with stack/service/org. This alone instruments any app already using an OTel SDK, with literally zero user action beyond the toggle.
- **Auto-instrumentation (opt-in, later phase):** for popular runtimes, optionally inject a zero-code agent (e.g. `OTEL_*` + a language auto-instrumentation init container/sidecar or a baked-in agent path) so even apps that don't call the OTel SDK emit traces. Phase 2 — risky/runtime-specific, kept off the critical path.
- **Logs** flow without app changes: the node collector's `filelog`/Docker-driver receiver tails container stdout/stderr (which swarmy already captures via `streamLogs`), parses, stamps `swarmy.*` + `trace_id` (when apps log it), and ships to ClickHouse. So "logs" works the instant a stack is opted in, even for an uninstrumented app.

The toggle is a single switch in the UI ("Enable observability for this stack"). Turning it off removes the injected env/labels on next deploy and stops storing that stack's data — individually disableable per the project principle.

### Wire protocol — new message types (`packages/core/src/protocol/`)

New file `protocol/telemetry.ts`, registered in `messages.ts` discriminated unions. Each controller→agent command carries the standard `{ commandId, timeoutMs? }` preamble and returns existing `commandResult` / `logChunk` frames — **no transport changes**, reusing correlation + subscriptions.

Controller → agent:
- **`applyCollector`** — `{ commandId, rendered: RenderedCollectorConfig }`. Agent writes the collector YAML, deploys/updates the node `global` + gateway `replicated` collector services (via dockerode), reloads. **Mirrors `applyIngress` exactly** (write files → set service labels → reload/admin-API). This is the key "new capability = new render type, not an agent rewrite" payoff.
- **`applyObservabilityStore`** — `{ commandId, rendered: RenderedStoreDeployment }`. Bring up/configure ClickHouse on this node (manager): write config, deploy the Swarm service, run init DDL. Analogous to the volumes-DR `applyStorageNode`.
- **`telemetryStatus`** (query) — `{ commandId }` → collector health, queue/drop counters, exporter up/down, ClickHouse reachability. (Or fold into the heartbeat snapshot — see below.)

Agent → controller:
- **No new high-volume telemetry frames.** Trace/metric/log data does **not** flow over the swarmy WS — it goes app → node collector → gateway → ClickHouse directly (data plane). The WS stays control-plane only. This is deliberate: it keeps the agent WS lightweight and lets telemetry scale independently.
- Extend the existing **`heartbeat`**/**`metrics`** snapshot with an optional `telemetry` health block (`collectorUp`, `spansAccepted`, `spansDropped`, `exportErrors`, `storeReachable`) so collector health shows in the existing node/cluster snapshot rings without a new top-level message.

The existing `NodeMetricsSample`/`ContainerMetricsSample` frames stay as-is for the **live** resource ring (see evolution below).

### How data reaches the UI (two paths, deliberately)

1. **Historical / analytical (traces, app metrics, logs, resource history):** controller's **`telemetry.service`** queries **ClickHouse** directly (a ClickHouse HTTP/native client in `apps/api`), via `TraceQuery`/`MetricQuery`/`LogQuery` builders, exposed through the `telemetry` tRPC router. The controller is the *only* thing that talks to ClickHouse (org-scoping + RBAC + audit enforced in the service layer — every query is constrained by `swarmy.org_id`; users never get raw ClickHouse access). The node-collector→gateway→ClickHouse path delivers the data; the controller reads it back out scoped + authorized.
2. **Live (already exists):** the in-memory snapshot ring + tRPC subscriptions (`metrics.overviewLive`, `subscribeNodeStats`) continue to serve real-time resource stats and now also a live "spans/sec, error rate" tile sourced from the gateway's `telemetryStatus` / a short ClickHouse tail. No change to the live mechanism.

### Evolution of the in-memory ring + `MetricSample`

Keep what's good, offload the heavy part:

- **In-memory ring (GatewayStore):** unchanged. It stays the source for *live* node/container resource stats and live subscriptions — it's the right tool for "last N seconds, real-time." It's not storage and shouldn't become storage.
- **`MetricSample` (Postgres):** today it's the *only* history store (one downsampled row per node per interval). It does not scale to app metrics/high cardinality, and it duplicates what ClickHouse does far better. Plan:
  - **Phase 1:** keep `MetricSample` exactly as is — the resource-metrics history path is untouched and ships independently of ClickHouse. (Telemetry is additive; the existing dashboards keep working with zero ClickHouse dependency.)
  - **Phase 2 (when ClickHouse is enabled):** add an **OTel `hostmetrics`** path so node/container resource metrics *also* land in ClickHouse with the same OTLP model as everything else. The `metrics.service` reads (timeseries/overview) gain a **backend switch**: if the org has the observability store enabled, read resource history from ClickHouse (richer, longer retention, unified with app metrics); otherwise fall back to `MetricSample`/Postgres. The `metrics-sampler` worker's Postgres write becomes a no-op (or short-window-only) when ClickHouse is the store, eliminating the Postgres write-amplification the worker's comment already worries about.
  - **`MetricSample` becomes the zero-dependency fallback**, not the primary. We never force ClickHouse on a user who just wants basic node CPU graphs — that's the simplicity floor.

### DB models (`packages/db/prisma/schema.prisma`)

ClickHouse holds the telemetry *data*; **Postgres holds telemetry config/metadata** (org-scoped, cuid + timestamp conventions, cascade FKs to `Organization`). New enums: `TelemetrySignal { TRACES METRICS LOGS }`, `ObservabilityStoreDriver { CLICKHOUSE NONE }`, `SamplingMode { ALWAYS ERRORS_AND_SLOW RATIO TAIL }`.

- **`ObservabilityConfig`** — `{ id, orgId @unique, storeDriver, enabled, retentionDays Json (per-signal), samplingMode, samplingRatio, gatewayNodeIds Json, settings Json, createdAt, updatedAt }`. One per org, analogous to `IngressConfig`. Holds the store + collector topology + retention + sampling.
- **`StackTelemetry`** (or extend `Stack`) — per-stack opt-in: `{ stackId, signals Json (which of traces/metrics/logs), samplingOverride?, enabled }`. Cheapest: add `telemetry Json @default("{}")` to `Stack` and a `telemetryEnabled Boolean @default(false)` flag; same additive pattern as the volumes-DR `Service.volumeMode`. Service-level override mirrors it on `Service`.
- **`ObservabilityStoreState`** — `{ id, orgId, nodeId, clickhouseServiceId, status, version, diskUsedBytes, lastCheckedAt }` — the deployed store's health/footprint for the UI (like ingress status surfacing).
- No per-signal data tables in Postgres — that's ClickHouse's job. Retention is enforced by **ClickHouse TTLs** (set in DDL from `retentionDays`), not a Postgres delete worker. The existing `retention.ts` worker keeps owning `MetricSample` only.

ClickHouse schema (created by `StoreRenderer` init DDL, adapted from the OTel Collector ClickHouse exporter + Jaeger-compat layout):
- `otel_traces` (span-per-row: `trace_id`, `span_id`, `parent_span_id`, `service_name`, `span_name`, `kind`, `start`, `duration_ns`, `status_code`, `attributes Map`, `swarmy_org_id`, `swarmy_stack`) + a `trace_id_ts` index table for fast trace lookup; materialized views for service-list and latency-quantile rollups.
- `otel_logs` (`timestamp`, `trace_id`, `span_id`, `severity`, `body`, `service_name`, `swarmy_*`, `attributes Map`).
- `otel_metrics_*` (sum/gauge/histogram tables per OTel metric type, incl. resource metrics from `hostmetrics`).
- All tables `PARTITION BY toDate(timestamp)` + `TTL timestamp + INTERVAL <retentionDays> DAY` for cheap range-drop retention. `swarmy_org_id` in the sort key so every controller query is org-pruned at the storage layer.

### Controller: tRPC routers + services + worker (`packages/trpc`, `apps/api`)

New router `packages/trpc/src/routers/telemetry.ts`:
- **Config:** `getConfig`, `setStore` (driver/enable), `setRetention`, `setSampling`, `enableForStack` / `disableForStack`, `previewCollectorConfig` (mirrors ingress `previewConfig`), `status`.
- **Traces:** `searchTraces` (filters: service/stack/operation/duration/status/time-range/attributes), `getTrace` (full span tree by `trace_id`), `serviceMap` (edges from span parent/child + `service.name`).
- **Metrics (app):** `appMetrics` (RED: rate/errors/duration per service, latency quantiles, custom metric query), reusing the existing `MetricKind`/`TimeRange` shapes where possible.
- **Logs:** `searchLogs` (full-text + attribute filters + `trace_id` correlation), `logsForTrace`.
- **Live:** `liveThroughput` subscription (spans/sec, error rate) over the existing subscription mechanism.

New services: `telemetry.service.ts` (the ClickHouse-querying read layer, **org-scoped on every query**), `collector.service.ts` (renders via `@swarmy/telemetry`, dispatches `applyCollector`/`applyObservabilityStore` through `ctx.hub.dispatch` using `resolveManagerNode`/`requireOnlineNode` from `dispatch.service.ts`). Add `CommandName`s `telemetry.applyCollector`, `telemetry.applyStore`, `telemetry.status` to `hub/types.ts` + their `COMMAND_PROTOCOL_TYPE` mapping. All mutations audited via the existing `AuditLog` path.

New worker `apps/api/src/workers/telemetry-rollup.ts` (registered next to `metrics-sampler`/`retention`): optional periodic ClickHouse maintenance (refresh rollup MVs, verify TTLs, collect store footprint into `ObservabilityStoreState`, surface exporter drop alerts). Retention itself is TTL-driven in ClickHouse, so this worker is light. Add a ClickHouse client to `apps/api` (native or HTTP), configured by env, only connected when an org has the store enabled.

### Agent capabilities (`apps/agent/src/`)

New `apps/agent/src/telemetry.ts` invoked from `executor.ts` for `applyCollector` / `applyObservabilityStore` (the `telemetryStatus` query too). Reuses the **exact** ingress mechanics already in `applyIngress` (write `RenderedFile`s, set service labels, reload/admin-API) plus dockerode `deployService` for the collector/ClickHouse Swarm services. Pinned images: `otel/opentelemetry-collector-contrib`, `clickhouse/clickhouse-server`. The agent stays generic — new signals/processors/exporters are new render output, not agent code changes (the architecture's whole point).

### UI surfaces (`apps/app`)

- **New top-level "Observability" / "Mission Control" section** (nav item, off until enabled), with:
  - **Trace explorer:** search bar (service/stack/op/duration/status/time) → result list → **`TraceWaterfall`** (span gantt) + **`SpanDetail`** (attributes, events, links) — the one genuinely new UI. Deep-link: a service/deployment page → "View traces."
  - **Service map:** node-link graph of service→service calls with error/latency coloring (derived from spans).
  - **Metrics dashboards:** RED per service (rate/errors/p50/p95/p99), reusing `@swarmy/ui` `charts.tsx`/`sparkline`; cluster + per-stack views. The existing node/container resource dashboards stay and gain ClickHouse-backed longer history when enabled.
  - **Log search:** filter by service/stack/severity/time + full-text; one-click "show logs for this trace" / "show trace for this log" correlation.
- **Stack detail → "Observability" tab:** the per-stack enable toggle, which signals, sampling override, and quick links to that stack's traces/metrics/logs.
- **Settings → Observability (advanced):** enable the store (ClickHouse), choose gateway nodes, retention sliders per signal, sampling mode/ratio, store footprint/health, "preview collector config" (the ingress-style preview), and the off-by-default "expose raw Jaeger/Grafana" escape hatch.

## MVP vs later

**MVP (Phase 1 — traces + logs, native UI, one stack):**
`@swarmy/telemetry` with `CollectorRenderer` + `StoreRenderer`; `ObservabilityConfig` + `Stack.telemetry` models; `applyCollector` + `applyObservabilityStore` protocol + agent impl (reusing ingress mechanics); ClickHouse single-node deploy + trace/log DDL with TTLs; node `global` + gateway collector with **OTLP receivers + tail sampling + ClickHouse exporter + filelog**; per-stack opt-in via `OtelInjection` (zero-code env/label injection only); `telemetry` tRPC router (`searchTraces`/`getTrace`/`searchLogs`/config); native **TraceWaterfall + SpanDetail + log search**; Settings + Stack "Observability" tab. This delivers the headline: opt a stack in, get traces + correlated logs in swarmy's own Jaeger-style UI. **Ship this first.**

**Phase 2 — app metrics + resource-metrics unification:**
`hostmetrics` receiver → resource metrics into ClickHouse; RED dashboards + custom metric queries; `metrics.service` backend switch (ClickHouse when enabled, `MetricSample` fallback); service map; live throughput tile. Now metrics, traces, logs are unified and the Postgres write-amplification goes away when the store is on.

**Phase 3 — depth & scale:**
Auto-instrumentation injection for popular runtimes (true zero-code traces for uninstrumented apps); tail-sampling policy UI; ClickHouse Keeper cluster (replicated/HA store, gateway autoscale); alerting on telemetry (error-rate/latency SLOs) tied into the existing notification path; optional Jaeger/Grafana escape-hatch deployments; later: profiling (Pyroscope) as a fourth signal — additive, same model.

## Dependencies

- **On the volumes/DR + scheduling epics:** ClickHouse is **stateful** — its data volume must use that epic's volume management (clustered volume or backed-up `local` volume); losing the ClickHouse node else loses telemetry history. The store deploy reuses their `provisionVolume`/volume-mode work. Backups of ClickHouse ride the same `BackupTarget` mechanism.
- **On the ingress/overlay-network epic:** the OTLP endpoint apps target (`otel-collector:4317`) needs a stable name on the swarmy overlay network reachable from every stack's containers — depends on the shared overlay/network conventions (the `IngressGlobalOptions.network = "swarmy"` already in the scaffold is the seed).
- **On the deployment epic:** `OtelInjection` must run in the deploy path (`composeToSpecs`/`deployFromCompose`/service deploy) before `service.deploy` dispatch, and re-run on redeploy when a stack's telemetry toggle changes.
- **Infra:** pinned `otel/opentelemetry-collector-contrib` + `clickhouse/clickhouse-server` images bundled/pullable by the agent; a ClickHouse client dependency in `apps/api`; new env (ClickHouse connection, default retention/sampling); Prisma migration for the config models. No new env secrets beyond the store's generated creds (handled like other generated secrets).
- **No new transport:** rides the existing dial-out WS + command correlation for control; telemetry *data* uses its own app→collector→ClickHouse data plane (intentionally off the WS).

## Risks & open questions

- **ClickHouse footprint vs swarmy's "tiny" promise.** ClickHouse is heavier than the rest of swarmy. Mitigations: it's strictly opt-in (zero footprint when off); single-node default tuned for small RAM (~1.5GB-class start, as SigNoz demonstrates); aggressive **tail sampling** as the default (keep errors/slow, sample the rest) so trace volume — the main cost driver — stays bounded; TTL retention defaults short (e.g. 7d traces/logs, 30d metrics) with UI sliders. Open: do we ever offer a *no-ClickHouse* "traces-lite" mode (e.g. small DuckDB/Parquet or even Tempo-single-binary) for very small nodes? Probably not in v1 — one store, keep it simple.
- **Single-node store = single point of failure for telemetry.** Acceptable for observability data (it's not the app's primary data); HA ClickHouse (Keeper) is Phase 3. We must make the store's own failure non-fatal: collectors buffer/drop with backpressure, app traffic is never affected by telemetry-store outages (the data plane must fail open).
- **Cardinality / cost blow-ups.** High-cardinality attributes (user IDs, URLs with IDs) can explode ClickHouse. Mitigations: enrichment/redaction processors at the gateway, attribute allow/deny lists, sane defaults, and footprint surfacing in the UI so users see growth before it hurts.
- **Build-vs-embed for the trace UI is the biggest scope risk.** Building a good waterfall + service map is real work. Mitigation: phase it (waterfall first, service map Phase 2), reuse `@swarmy/ui`, and keep the **Jaeger escape hatch** so we're never blocked — if the native UI is thin, the standard tools still work against the same store.
- **Unopinionated guarantee for injection.** Injecting `OTEL_*` env/labels must be a strict no-op for apps that don't use OTel, and must never alter image/command/behavior. Open: how to handle apps that *already* set `OTEL_EXPORTER_OTLP_ENDPOINT` themselves — respect user-set values (don't overwrite), only fill what's absent.
- **Collector lifecycle coupling.** The collector is a Swarm service swarmy manages but that users could also see/touch via raw Docker. Need drift handling (re-apply on divergence) like ingress label sync, and clear "this is swarmy-managed" labeling.
- **OTel Collector ClickHouse exporter / schema stability.** The exporter and its schema evolve; pin versions, vendor the DDL we depend on (don't rely on exporter auto-DDL in prod), and test the Jaeger-compat tables before promising the escape hatch.
- **PII in traces/logs.** Storing request data raises privacy obligations. Default redaction processors + a clear data-locality story (it's all in *your* ClickHouse, on *your* nodes — a selling point vs SaaS APM).

## Simplicity note

The epic stays one-command/zero-config because of one decision: **opt-in is a single toggle, and turning it on does everything.** Flip "Enable observability" on a stack and swarmy (a) stands up ClickHouse + the collectors if not already running, (b) injects the OTLP env/labels on the next deploy so the app auto-ships traces/metrics/logs with zero code changes, and (c) lights up the Mission Control UI scoped to that stack. The user never writes a collector YAML, a scrape config, a ClickHouse query, or a retention rule — those exist behind "advanced" with sane defaults (tail sampling on, 7-day traces, errors-always-kept).

It honors "pluggable, individually disableable": **off by default ⇒ zero footprint, zero ClickHouse, identical app behavior** (the stack runs exactly the same with or without telemetry — unopinionated all the way down). Each signal (traces/metrics/logs) is independently toggleable. And because everything is one ClickHouse store queried through swarmy's own org-scoped, audited UI, there's **one mental model** ("turn on observability for this stack, look at it here") instead of "deploy and wire up four services and a separate dashboard" — which is exactly the misery this epic exists to delete. The data is in open OTLP/ClickHouse with standard escape hatches, so even the observability layer keeps swarmy's no-lock-in, unopinionated promise.
