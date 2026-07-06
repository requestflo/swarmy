# Observability — "flip it on, and traces, metrics and logs just land"

**Status: canonical product design (2026-07). Pairs with the `observability-otel`
skill for the how.**

## The feeling we are building

Someone running a stack on swarmy should get from "I have no idea what my app is
doing" to "I can see every request, every service edge, every log line" without
editing a single line of app code or standing up Grafana.

1. In the stack workspace they open the **Observability** tab. It says the stack
   is dark: "Flip it on and `storefront` gets `OTEL_*` env injected on its next
   deploy — traces, metrics and logs land here." One toggle.
2. They flip it on and redeploy (or wait for the next deploy). swarmy stamps the
   stack's services with telemetry env + labels and — the first time any stack in
   the org turns it on — quietly deploys **one** OTel Collector and **one**
   ClickHouse store as swarmy-system services. No wizard, no DSN to paste.
3. Within a minute the tab shows **Collector: Running · Live** and **Store:
   Reachable**. Traces start filling a **Jaeger-lite** list — no embedded Jaeger,
   swarmy's own UI. The **service map** draws itself from the spans: web → api →
   checkout, each edge labelled with its call rate, error rate and p95; a degraded
   edge glows amber.
4. A checkout error spikes. The stack's health line stops saying "Quiet and green"
   and says, in plain words, "checkout: error rate 6.2% (target <5.0%)". They open
   **Logs**, filter to `checkout` + `Error+`, click a line, and **jump straight to
   the trace behind it** — the waterfall shows the 1.8s span that blew the budget.
5. That same signal, if they wired a rule, fired an **alert**, which opened an
   **incident**, which is already reflected on the stack's public **status page**
   at `/s/<slug>` with a 90-day uptime bar — customers saw it before they emailed.

No agent to install per app. No OTLP endpoint to configure. No second store to
run. It should feel like the telemetry was *always there* and you just turned the
lights on — because turning it on injects only environment, and everything that
reads that environment (traces, metrics, logs, health, alerts, status) is swarmy's.

## How it works (the injection path)

```
stack Observability tab: "Enable observability"
   │  ① stamp swarmy.otel.enabled=true on the stack's services (Docker LABEL,
   │     not a DB column) → first org opt-in deploys the swarmy-system suite
   ▼
managed suite (deployed via the EXISTING service.deploy path — no new protocol)
   swarmy-otel-collector  (OTLP :4317/:4318 on the `swarmy` overlay)
   swarmy-clickhouse      (one store; the collector OWNS its schema)
   │  ② next deploy runs each ServiceSpec through injectOtel():
   │     +OTEL_EXPORTER_OTLP_ENDPOINT=http://swarmy-otel-collector:4317
   │     +OTEL_SERVICE_NAME · +OTEL_RESOURCE_ATTRIBUTES(swarmy.org_id/stack/service)
   │     +labels swarmy.telemetry=on · +joins the `swarmy` overlay
   ▼
app auto-exports OTLP → collector enriches + exports → ClickHouse
   otel_traces · otel_metrics_* · otel_logs   (partition-by-day, TTL = retentionDays)
   │  ③ collector's `filelog` also tails container stdout → logs land with
   │     zero app changes, even for an uninstrumented image
   ▼
controller reads ClickHouse over HTTP, org-scoped on EVERY query
   traces · service map · metrics · logs · health narrative → the tab + top-level UI
   │  ④ health/RED feed alerts → incidents → public status page (/s/<slug>)
```

Four ideas, one story:

- **Turning it on injects only environment — never code, never the image.**
  `injectOtel` adds `OTEL_*` env + `swarmy.*` labels and joins the overlay; it
  never touches the image, command, or behaviour, and it **never overwrites a
  value the user already set** (point at your own collector and you win). For an
  app that ignores `OTEL_*` it is a strict no-op — the stack runs byte-identically
  with telemetry off, so opting in is safe and opting out is a clean revert.
- **One store, and the collector owns its schema.** There is exactly one
  ClickHouse per org and one Collector, deployed as ordinary swarmy-system
  services through the existing deploy path — no new agent command, no new wire
  message. The ClickHouse exporter runs with `create_schema: true`, so the
  collector's DDL is the single source of truth for the tables; swarmy only
  ensures the database exists and sets retention as a per-table `TTL`.
- **The controller is the only thing that reads ClickHouse.** Every trace/metric/
  log query is built server-side, constrained by `ResourceAttributes['swarmy.org_id']`
  on both join sides, with literals escaped and windows clamped. Users never get
  raw ClickHouse; they get org-scoped, audited tRPC procedures.
- **The trace UI is swarmy's, not embedded Jaeger.** A native list → waterfall →
  span-detail, a native service map, native RED dashboards, and correlated logs —
  one design system, one nav, traces↔logs↔metrics linked by `trace_id` and
  `service.name`.

## Roles and where truth lives

- **The per-stack opt-in is a Docker LABEL, not a DB flag.** `swarmy.otel.enabled`
  is stamped on the stack's services (`enableForStack`) and re-stamped by
  `injectOtel` on every injected deploy so it survives redeploys;
  `stackTelemetryEnabled` reads it back from the **live inventory**. A service can
  override the stack three-state (`true` forces on, `false` forces a noisy service
  dark). This replaces the old `Stack.telemetryEnabled` column — see the
  `docker-native-storage` skill.
- **The telemetry data itself lives in ClickHouse, never Postgres.** Traces,
  spans, app metrics, and log lines are the collector's write path; swarmy's DB
  never mirrors them. Retention is a ClickHouse `TTL`, not a swarmy delete loop.
- **What swarmy's DB owns is only its own control state + queryable history**:
  `ObservabilityConfig` (org `enabled`, encrypted `clickhouseDsn`,
  `collectorStatus`, `retentionDays`), `ObservabilityStoreState` (last-probed
  `reachable` + `diskUsedBytes` footprint), and the alerting spine —
  `AlertRule`/`AlertEvent`, `Incident`/`IncidentEvent`, `StatusPage`/`UptimeSample`,
  `NotificationChannel` (config encrypted via the vault, never returned to
  clients). Identity, access, audit, and the *history of what fired* — swarmy's;
  the raw signal firehose — ClickHouse's.
- **Health is composed, never stored.** The plain-words narrative
  (`health-summary.ts`) is recomposed each read from live tasks, DB replica lag,
  queue depth, and RED metrics — it is a view, not a table.

## Observability behaviour (what the promise commits us to)

- **Off by default, individually disableable, unopinionated.** No stack ships
  telemetry until its toggle is on; turning it off drops the env/labels on next
  deploy and stops the stack's data landing. The whole suite has zero footprint
  when no org has enabled it — ClickHouse is heavy, so it is strictly opt-in.
- **Logs work the instant you opt in — even for an uninstrumented image.** The
  node collector's `filelog` receiver tails container stdout, so "Logs" is
  populated before the app knows what OpenTelemetry is; if the app logs a
  `trace_id`, the log line jumps to its trace.
- **The service map is derived, not declared.** Edges come from client/server
  span-kind pairs (`A`'s CLIENT span parenting `B`'s SERVER span); RED is measured
  server-side — what B's callers actually experienced. A node or edge tints
  degraded above p95 1500ms or error rate 5% (mirrors the health targets).
- **Health speaks in sentences, not gauges.** "checkout: error rate 6.2% (target
  <5.0%)", "p95 1.8s", "database replica lag …", "queue depth rising" — and if the
  collector failed or the store is unreachable it says so, because a blind check is
  worse than a red one.
- **Alerts → incidents → status.** A fired `AlertEvent` (deduped on rule/signal +
  resource) can enrich or open an `Incident`; open incidents surface on the stack's
  public status page (`/s/<slug>` or a custom domain) with 90-day uptime bars
  sampled by the alert-evaluator worker. Every fire, resolve, and override is
  audited.

## Failure modes (designed, not accidental)

| Failure | Behaviour |
|---|---|
| Telemetry store (ClickHouse) down or unreachable | App traffic is never affected — telemetry is not the app's primary data. Reads return empty + a clear "store unreachable" status; the reconcile worker marks it not-reachable; health says latency/error checks are blind rather than green. |
| Collector failed to deploy | `collectorStatus: FAILED`; the health narrative surfaces "telemetry collector failed to deploy — latency and error-rate checks are blind" instead of implying all-clear. |
| App already sets its own `OTEL_*` (own collector) | User values win — `injectOtel` only fills absent keys, never overwrites. The stack ships to the user's endpoint, not swarmy's. |
| Stack toggled off | Next deploy drops the injected env/labels; the stack runs byte-identically to never-instrumented (golden guarantee); its data stops landing and TTL-expires. |
| Trace volume / ClickHouse footprint growing | Tail sampling at the gateway keeps errors/slow traces and samples the rest; retention is a short default `TTL`; the store's `diskUsedBytes` is surfaced in the UI so growth is visible before it hurts. |
| High-cardinality attributes | Enrichment/redaction at the gateway + clamped queries; org-scope is enforced on every read so cardinality can never leak across orgs. |

## Explicitly rejected

- **Embedding Jaeger / Grafana as the UI.** A native list→waterfall→map keeps one
  design system and one nav; the standard tools stay a Phase-3 escape hatch against
  the *same* ClickHouse, so we are never blocked, but they are not the product.
- **A second telemetry store, or a "traces-lite" no-ClickHouse mode.** One store,
  one collector, one schema. Multiple backends multiply the query surface and the
  ops burden for no user-visible win.
- **Mirroring spans/metrics/logs into Postgres.** The DB owns swarmy's own control
  state and the history of what *fired*, never the raw signal firehose — that is
  ClickHouse's job, TTL'd and partitioned. A column that shadows trace volume is
  the write-amplification bug we designed away.
- **Making telemetry change the app.** No injected sidecar, image rewrite, or
  command override in v1's zero-code path; only env + labels + an overlay join, so
  the unopinionated guarantee holds and opt-out is a clean revert.
- **A DSN to paste / a store to run yourself.** The suite deploys itself the first
  time an org opts in; the toggle is the entire configuration.

## Implementation map

The invariants and file map live in the `observability-otel` skill
(`.claude/skills/observability-otel/SKILL.md`) — the injection contract, the
ClickHouse query discipline, and the alerts→incidents→status spine. Key homes:
`packages/trpc/src/services/otel-injection.ts` (env/label injection, service
override), `observability-stack.ts` + `observability-render.ts` (managed specs +
collector/ClickHouse config, `create_schema: true`), `observability-query.ts` /
`observability-map.ts` (org-scoped ClickHouse SQL builders), `health-summary.ts`
(the plain-words narrative), `observability.service.ts` + `routers/observability.ts`
(the read/enable layer), the alerting spine
(`alerts.service.ts`/`alerts-fire.ts`/`incidents-record.ts`/`statusPages.service.ts`
+ their routers), `apps/api/src/workers/{observability-reconcile,alert-evaluator}.ts`,
and the UI at `apps/app/src/components/observability/*`, the top-level
`routes/_authed/observability{,.$traceId}.tsx`, and the public status page at
`routes/s.$slug.tsx`. Deep design: `plans/epic-mission-control-otel.md`.
