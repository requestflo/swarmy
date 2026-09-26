/**
 * Telemetry settings (ObsSettings board): sampling, per-signal retention and
 * redaction for the org's ONE collector + store, the disk forecast, and the
 * pipeline status.
 *
 * WHERE IT LIVES: the settings are org-level infra config a reconciler
 * converges (docker-native-storage rule 6), so they sit in the org's existing
 * swarm-kv `obs/<orgId>` document next to `enabled` / DSN / `retentionDays` —
 * small, changed at human speed, and needed to rebuild the collector after a DR
 * restore. Nothing here is a label (it describes no single service) or a DB
 * row. Whether the running collector carries them is Docker truth: the live
 * collector's content-addressed config name vs the current render.
 *
 * APPLY: saving re-renders the collector config (a new content-addressed
 * Docker config) and converges the suite through the normal `service.deploy`
 * path, which swaps the collector's config — apps are never restarted and the
 * store's spec is unchanged. Retention is a `MODIFY TTL` per table, run here
 * and re-checked by the observability reconcile worker (signature-gated).
 */
import {
  clickhouseClient,
  parseClickhouseDsn,
  type TelemetryForecastView,
  type TelemetryPipelineView,
  type TelemetrySettings,
  type TelemetrySettingsView,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { observabilityConfigRepo, type ObservabilityConfigRow } from './observability-config.repo';
import {
  desiredConfigs,
  latestStoreProbe,
  liveSuiteStatus,
  reconcileObservabilitySuite,
  safeDecrypt,
  telemetrySettingsFor,
} from './observability.service';
import {
  buildDiskQuery,
  buildPartsByDayQuery,
  buildRetentionStatements,
  buildSpanRateQuery,
  buildTablesQuery,
  retentionSignature,
  SIGNAL_TABLES,
  SPAN_RATE_WINDOW_S,
  summariseParts,
  type PartsRow,
} from './observability-retention';
import {
  CLICKHOUSE_NODE_LABEL,
  CLICKHOUSE_SERVICE,
  COLLECTOR_SERVICE,
  OTLP_GRPC_PORT,
  OTLP_HTTP_PORT,
} from './observability-stack';

function storeDsn(row: ObservabilityConfigRow): string | null {
  return row.enabled && row.clickhouseDsn ? safeDecrypt(row.clickhouseDsn) : null;
}

function hostnameFor(ctx: OrgContext, swarmNodeId: string | undefined): string | null {
  if (!swarmNodeId) return null;
  return ctx.hub.nodeInventory(ctx.activeOrgId, true).find((n) => n.swarmNodeId === swarmNodeId)?.hostname ?? null;
}

/** The server a suite service's running task is on (task container label), else its pin. */
function serviceNode(ctx: OrgContext, service: string): string | null {
  const inv = ctx.hub.liveInventory(ctx.activeOrgId);
  const svc = inv.services.find((s) => s.name === service);
  const task = svc
    ? inv.containers.find((c) => c.serviceId === svc.id && c.state === 'running')
    : undefined;
  return hostnameFor(ctx, task?.labels['com.docker.swarm.node.id'] ?? svc?.labels[CLICKHOUSE_NODE_LABEL]);
}

/* ----------------------------------------------------------------------------
 * Settings
 * ------------------------------------------------------------------------- */

export async function getTelemetrySettings(ctx: OrgContext): Promise<TelemetrySettingsView> {
  const row = await observabilityConfigRepo.get(ctx, ctx.activeOrgId);
  const settings = telemetrySettingsFor(row);
  const dsn = storeDsn(row);
  if (!dsn) return { settings, suiteEnabled: false, applied: false, appliedAt: null };
  const desired = desiredConfigs(parseClickhouseDsn(dsn), row).collector.name;
  const collector = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === COLLECTOR_SERVICE);
  const applied = Boolean(collector && collector.runningReplicas > 0 && (collector.configs ?? []).includes(desired));
  return {
    settings,
    suiteEnabled: true,
    applied,
    appliedAt: applied && collector ? new Date(collector.updatedAt).toISOString() : null,
  };
}

function auditSummary(s: TelemetrySettings) {
  return {
    slowTraceMs: s.sampling.slowTraceMs,
    restPercent: s.sampling.restPercent,
    retention: s.retention,
    redaction: s.redaction.map((r) => `${r.id}:${r.enabled ? 'on' : 'off'}`),
  };
}

/**
 * Save the settings, then apply them: converge the collector onto the new
 * render now (skipping the worker's throttle) and set each table's TTL.
 */
export async function setTelemetrySettings(
  ctx: OrgContext,
  input: TelemetrySettings,
): Promise<TelemetrySettingsView> {
  const before = telemetrySettingsFor(await observabilityConfigRepo.get(ctx, ctx.activeOrgId));
  // `retentionDays` is left alone on purpose: it is on the store's spec, so
  // changing it would restart ClickHouse. Per-signal TTLs replace it.
  const row = await observabilityConfigRepo.update(ctx, ctx.activeOrgId, { telemetry: input });
  await writeAudit(ctx, {
    action: 'observability.setSettings',
    targetType: 'org',
    targetId: ctx.activeOrgId,
    metadata: { before: auditSummary(before), after: auditSummary(input) },
  });
  if (storeDsn(row)) {
    await reconcileObservabilitySuite(ctx, { force: true });
    // Tables can be missing on a fresh store — the worker retries until all exist.
    await reconcileObservabilityRetention(ctx).catch(() => undefined);
  }
  return getTelemetrySettings(ctx);
}

/* ----------------------------------------------------------------------------
 * Retention (per-table TTL), signature-gated for the reconcile worker
 * ------------------------------------------------------------------------- */

const lastRetentionSig = new Map<string, string>();

/**
 * Converge every exporter table's TTL onto the per-signal retention. Skips
 * when the signature is unchanged; records it only once every table existed
 * and took its TTL, so a fresh store is retried on the next tick.
 */
export async function reconcileObservabilityRetention(ctx: OrgContext): Promise<{ skipped: boolean; statements: number }> {
  const row = await observabilityConfigRepo.find(ctx, ctx.activeOrgId);
  const dsn = row ? storeDsn(row) : null;
  if (!row || !dsn) return { skipped: true, statements: 0 };
  const ch = clickhouseClient(dsn, { timeoutMs: 8000 });
  const retention = telemetrySettingsFor(row).retention;
  const sig = retentionSignature(ch.database, retention);
  if (lastRetentionSig.get(ctx.activeOrgId) === sig) return { skipped: true, statements: 0 };
  const tables = (await ch.json<{ name: string }>(buildTablesQuery(ch.database))).map((t) => t.name);
  const statements = buildRetentionStatements(ch.database, retention, tables);
  for (const stmt of statements) await ch.exec(stmt);
  const expected = Object.values(SIGNAL_TABLES).reduce((n, t) => n + t.length, 0);
  if (statements.length === expected) lastRetentionSig.set(ctx.activeOrgId, sig);
  return { skipped: false, statements: statements.length };
}

/* ----------------------------------------------------------------------------
 * Disk forecast (raw measured numbers; the dashboard projects them)
 * ------------------------------------------------------------------------- */

export async function telemetryForecast(ctx: OrgContext): Promise<TelemetryForecastView> {
  const row = await observabilityConfigRepo.get(ctx, ctx.activeOrgId);
  const dsn = storeDsn(row);
  const base: TelemetryForecastView = {
    status: 'disabled',
    signals: [],
    usedBytes: null,
    freeBytes: null,
    totalBytes: null,
    node: null,
    measuredRestPercent: telemetrySettingsFor(row).sampling.restPercent,
    measuredAt: new Date().toISOString(),
  };
  if (!dsn) return base;
  const ch = clickhouseClient(dsn, { timeoutMs: 8000, unquote64BitInts: true });
  const node = serviceNode(ctx, CLICKHOUSE_SERVICE);
  let parts: PartsRow[];
  try {
    parts = await ch.json<PartsRow>(buildPartsByDayQuery(ch.database));
  } catch {
    return { ...base, status: 'unreachable', node };
  }
  const disk = await ch
    .json<{ free_space: number | string; total_space: number | string }>(buildDiskQuery())
    .then((r) => r[0] ?? null)
    .catch(() => null);
  const signals = summariseParts(parts, Date.now());
  const num = (v: number | string | undefined): number | null => {
    const n = Number(v);
    return v === undefined || !Number.isFinite(n) ? null : n;
  };
  return {
    ...base,
    status: 'ok',
    signals,
    usedBytes: signals.reduce((a, s) => a + (s.bytes ?? 0), 0),
    freeBytes: num(disk?.free_space),
    totalBytes: num(disk?.total_space),
    node,
  };
}

/* ----------------------------------------------------------------------------
 * Pipeline status
 * ------------------------------------------------------------------------- */

export async function telemetryPipeline(ctx: OrgContext): Promise<TelemetryPipelineView> {
  const row = await observabilityConfigRepo.get(ctx, ctx.activeOrgId);
  const status = liveSuiteStatus(ctx, row);
  const dsn = storeDsn(row);
  let spansPerSecond: number | null = null;
  let reachable = false;
  if (dsn) {
    const ch = clickhouseClient(dsn, { timeoutMs: 5000, unquote64BitInts: true });
    reachable = await ch.ping().catch(() => false);
    if (reachable) {
      const r = await ch
        .json<{ spans: number | string }>(buildSpanRateQuery(ctx.activeOrgId, ch.database))
        .catch(() => null);
      const n = Number(r?.[0]?.spans);
      spansPerSecond = r && Number.isFinite(n) ? n / SPAN_RATE_WINDOW_S : null;
    }
  }
  const probe = latestStoreProbe(ctx.activeOrgId);
  return {
    enabled: row.enabled,
    collector: {
      status: status.collector,
      node: row.enabled ? serviceNode(ctx, COLLECTOR_SERVICE) : null,
      endpoints: [`${COLLECTOR_SERVICE}:${OTLP_GRPC_PORT}`, `${COLLECTOR_SERVICE}:${OTLP_HTTP_PORT}`],
      spansPerSecond,
    },
    store: {
      status: status.store,
      node: row.enabled ? serviceNode(ctx, CLICKHOUSE_SERVICE) : null,
      bytesUsed: probe?.reachable ? Number(probe.diskUsedBytes) : null,
      reachable,
    },
  };
}
