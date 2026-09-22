# Observability "Store" never leaves "Pending" — the stored ClickHouse DSN uses the wrong hostname, so the controller can never read back the telemetry it's successfully collecting

**Status:** Fixed in code (2026-09) — pending live re-verification. See "Fix applied" below.
**Severity:** Major — Observability is fully wired up and genuinely collecting real telemetry
data end-to-end (collector → ClickHouse write path works), but the dashboard can never display
any of it, and the top-level status forever reads "Pending"/degraded. This is a swarmy source bug,
independent of the already-documented [[swarm-routing-mesh-unreachable-in-lima-vm]] environment
issue — it reproduces from plain string inspection of the deployed stack config and would affect
any real deployment, not just this Lima VM.

## Symptom

Deploy → swarmy-system stack → Observability tab, with the OTEL toggle left off (telemetry
shipping is a separate per-stack opt-in) but the collector/store themselves already deployed.
"Collector: Running", "Store: Pending" indefinitely (observed still "Pending" 10+ minutes after
first deploy, well past any plausible cold-start window). Health panel: "telemetry store
unreachable — latency and error-rate checks are blind." Service map panel: "Store unreachable.
The collector is up but ClickHouse isn't answering yet."

Verified via direct node inspection that this is misleading — ClickHouse is not just "up", it is
being written to successfully:

```
$ docker service logs swarmy-otel-collector --tail 15
...
2026-07-11T11:17:56.753Z info service@v0.111.0/service.go:234 Everything is ready. Begin running
and processing data.
```

(An earlier restart or two failed with `lookup swarmy-clickhouse on 127.0.0.11:53: no such host`
and `dial tcp 10.0.1.7:9000: connect: connection refused` — ordinary DNS/connect races while the
ClickHouse service was still converging; Swarm's restart policy retried and the collector has now
been cleanly "Running" and processing for several minutes.) So the collector's own connection to
ClickHouse (hostname `swarmy-clickhouse`, native port 9000) is genuinely healthy. Only the
dashboard's own "Store" status — and, by the same code path, every telemetry read query — never
recovers.

## Root cause

Two different places in the codebase build a ClickHouse connection string for two different
purposes, and they disagree on the hostname:

1. **Collector's own exporter config** — correct. `observability-stack.ts:120-123` passes
   `clickhouseHost: CLICKHOUSE_SERVICE_HOST` (defined at `observability-stack.ts:21` as the literal
   string `'swarmy-clickhouse'`, matching the real Swarm service name created by
   `clickhouseServiceSpec()` at `observability-stack.ts:55`) into `renderCollectorConfig()`
   (`observability-render.ts:77-79`), which produces
   `tcp://swarmy-clickhouse:9000?dial_timeout=10s&compress=lz4` — this is exactly what the
   collector's `config.yaml` ships with, confirmed by the passing test at
   `observability-render.test.ts:28` (`expect(yaml).toContain('tcp://swarmy-clickhouse:9000')`).
   Since `swarmy-clickhouse` is genuinely the service's own name, Swarm's embedded DNS resolves it
   automatically — no alias needed — which is why the collector eventually connects fine.

2. **The DSN stored in the DB and used for every dashboard read** — wrong. `managedDsn()`
   (`observability.service.ts:134-137`):
   ```ts
   function managedDsn(password: string): string {
     return `http://default:${encodeURIComponent(password)}@clickhouse:${CLICKHOUSE_HTTP_PORT}/otel`;
   }
   ```
   hardcodes the literal hostname `clickhouse` — **not** `CLICKHOUSE_SERVICE_HOST`
   (`'swarmy-clickhouse'`). This function's result is stored as `row.clickhouseDsn` when
   observability is first enabled (`observability.service.ts:213`,
   `managedDsn(randomPassword())`), and that stored value is what every subsequent read uses:
   - `pingStore()` (`observability.service.ts:502-512`) — the exact "Store" health check —
     `fetch(`${dsn.baseUrl}/ping`, ...)`, where `dsn.baseUrl` comes from parsing the stored DSN's
     host, `clickhouse`.
   - `clickhouseJson()` (`observability.service.ts:533+`) and `clickhouseExec()`
     (`observability.service.ts:515-527`) — used by every logs/traces/metrics/service-map query
     (`observability.service.ts:366,378,391,405,588,622-623,658`) — same broken host.

   Because no Swarm network alias `clickhouse` (bare, without the `swarmy-` prefix) is ever
   configured anywhere (`clickhouseServiceSpec()` at `observability-stack.ts:50-77` sets no
   `Aliases`, only the default service-name DNS entry `swarmy-clickhouse` that Swarm provides
   automatically), a `fetch()` to `http://clickhouse:8123/...` can never resolve — not a race, not
   a cold-start delay, a permanently wrong hostname. `pingStore()`'s catch-and-return-`false` on
   any error (including DNS failure) is why the UI shows a calm "Pending" instead of a visible
   error — the failure is real and permanent, just swallowed.

   Confirmed this isn't a local-dev-only artifact: `deploy/swarmy.standard.stack.yml:40-86` shows
   the `controller` service is itself attached to the same `swarmy` overlay network
   (`networks: [swarmy]` at line 85-86) in the real production stack definition, so this exact
   mismatch reproduces on any real swarmy deployment, not just this Lima test environment.

## Why this matters

The actual telemetry pipeline works — collector ingests OTLP and writes to ClickHouse
successfully. But because of this one hardcoded-hostname typo, the dashboard can never confirm
that, never shows the health check as passing, and — more importantly — can **never read back any
logs, traces, or metrics it collects**, since every query path shares the same broken DSN. A user
enabling Observability gets a permanently "Needs attention" stack health banner and empty
logs/traces/metrics panels forever, even though the feature is, underneath, actually working.
This is a one-line fix hiding a total loss of the feature's read-side usability.

## Suggested fix direction

Change `managedDsn()` (`observability.service.ts:134-137`) to use the same
`CLICKHOUSE_SERVICE_HOST` constant (`'swarmy-clickhouse'`) that `observability-stack.ts` already
exports and correctly uses for the collector's own config, instead of the hardcoded literal
`'clickhouse'`. Given `observability.service.ts` doesn't currently import from
`observability-stack.ts` for this purpose, that import needs adding. After the fix, existing orgs
that already have a stored (broken) DSN in their `clickhouseDsn` column would need it
regenerated/migrated — either a data migration or detecting-and-repairing the wrong host on next
`getStatus()`/`setEnabled()` call, since the DSN is generated once at enable-time and persisted.

Add a regression test alongside the existing `observability-render.test.ts` coverage (which
already correctly asserts the collector's hostname) that asserts `managedDsn()` / the stored DSN
resolves to the same host constant — this is exactly the kind of two-similar-strings-diverge bug a
single shared-constant assertion would have caught immediately.

## Not yet tested

Whether logs/traces/metrics panels visibly show empty state vs. a loading spinner vs. some other
UI treatment when `clickhouseJson()` returns `null` — not screenshotted this pass, since the
root cause (the DSN itself) was conclusive from source + live collector logs without needing to
separately reproduce each read panel's empty-state UI. Whether a manually-corrected DSN (out of
product-surface bounds for this sweep) would immediately fix the "Store: Pending" status and start
returning real data — not attempted, per the standing "no manual node fixes" boundary.

## Fix applied (2026-09)

- `packages/trpc/src/services/observability.service.ts`: `managedDsn()` now uses `CLICKHOUSE_SERVICE_HOST` (`swarmy-clickhouse`), the same constant the collector config uses.
- `parseDsn()` rewrites the legacy bare `clickhouse` host on read, so orgs whose DSN was already saved heal without re-enabling.
