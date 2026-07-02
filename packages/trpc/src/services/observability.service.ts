/**
 * Observability / Mission Control service — the MVP of epic #10.
 *
 * Decisions (see plans/epic-mission-control-otel.md):
 *  - ONE ClickHouse store + an OTel Collector, both deployed as swarmy-managed
 *    Swarm services via the EXISTING service-deploy path (`service.deploy`).
 *  - Per-stack opt-in: a `swarmy.otel.enabled` LABEL on the stack's services
 *    (Docker truth, per docker-native-storage — not a DB column) injects OTEL_*
 *    env at deploy time (see `otel-injection.ts`) — unopinionated, never touches
 *    code. `enableForStack` stamps/clears the label; `stackTelemetryEnabled` reads
 *    it back from the live inventory.
 *  - Reads (traces / metrics) query ClickHouse over its HTTP interface with
 *    `fetch`; if the store isn't configured we return empty + a clear status.
 *  - Everything is org-scoped and audited.
 *
 * NOTE: `ObservabilityConfig` / `ObservabilityStoreState` are new Prisma models
 * the integrator adds (see the INTEGRATION snippet). Until the client is
 * regenerated they are reached through {@link obsDb}, a narrow typed view of the
 * delegates this service uses. The shape matches the models exactly.
 */
import type { ServiceSpec } from '@swarmy/core/protocol';
import { randomBytes } from 'node:crypto';
import { buildInventory, UNGROUPED, type InvService } from '@swarmy/core';
import { encryptSecret, decryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { mapDispatchError, notFound } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { OTEL_ENABLED_LABEL } from './otel-injection';
import {
  collectorServiceSpec,
  clickhouseServiceSpec,
  observabilityConfigFiles,
  CLICKHOUSE_HTTP_PORT,
  OTEL_OVERLAY_NETWORK,
} from './observability-stack';
import { renderClickhouseInitSql } from './observability-render';
import {
  buildTracesQuery,
  buildTraceDetailQuery,
  buildMetricsSeriesQuery,
  buildMetricsSummaryQuery,
  type TraceRow,
  type SpanRow,
  type MetricsPoint,
  type MetricsSummaryRow,
  type TracesQueryInput,
  type TraceDetailQueryInput,
  type MetricsQueryInput,
  type MetricsSummaryQueryInput,
} from './observability-query';

export type CollectorStatus = 'OFFLINE' | 'DEPLOYING' | 'RUNNING' | 'FAILED';

export interface ObservabilityConfigView {
  enabled: boolean;
  collectorStatus: CollectorStatus;
  retentionDays: number;
  /** Whether a ClickHouse DSN is wired (the read path can reach the store). */
  storeConfigured: boolean;
  /** Host:port summary of the store, never the credentials. */
  storeEndpoint: string | null;
  updatedAt: string | null;
}

export interface ObservabilityStatusView extends ObservabilityConfigView {
  /** Live reachability of the ClickHouse HTTP endpoint, probed on read. */
  storeReachable: boolean;
  stacksEnabled: number;
}

/* ----------------------------------------------------------------------------
 * Narrow DB view of the new models (removed once the client is regenerated).
 * ------------------------------------------------------------------------- */

interface ObsConfigRow {
  id: string;
  orgId: string;
  enabled: boolean;
  clickhouseDsn: string | null;
  collectorStatus: string;
  retentionDays: number;
  updatedAt: Date;
}

interface ObsConfigDelegate {
  findUnique(args: { where: { orgId: string } }): Promise<ObsConfigRow | null>;
  upsert(args: {
    where: { orgId: string };
    create: Partial<ObsConfigRow> & { orgId: string };
    update: Partial<ObsConfigRow>;
  }): Promise<ObsConfigRow>;
  update(args: { where: { orgId: string }; data: Partial<ObsConfigRow> }): Promise<ObsConfigRow>;
}

function obsDb(ctx: OrgContext): ObsConfigDelegate {
  // `observabilityConfig` exists after the integrator adds the model + migrates.
  return (ctx.db as unknown as { observabilityConfig: ObsConfigDelegate }).observabilityConfig;
}

const DEFAULT_RETENTION_DAYS = 7;

async function ensureConfig(ctx: OrgContext): Promise<ObsConfigRow> {
  return obsDb(ctx).upsert({
    where: { orgId: ctx.activeOrgId },
    create: {
      orgId: ctx.activeOrgId,
      enabled: false,
      collectorStatus: 'OFFLINE',
      retentionDays: DEFAULT_RETENTION_DAYS,
    },
    update: {},
  });
}

/** A ClickHouse DSN, e.g. `http://default:pw@clickhouse:8123/otel`. */
interface ClickhouseDsn {
  baseUrl: string; // http://host:port
  user: string;
  password: string;
  database: string;
}

function parseDsn(dsn: string): ClickhouseDsn {
  const u = new URL(dsn);
  return {
    baseUrl: `${u.protocol}//${u.host}`,
    user: decodeURIComponent(u.username || 'default'),
    password: decodeURIComponent(u.password || ''),
    database: u.pathname.replace(/^\//, '') || 'otel',
  };
}

/** The DSN swarmy uses for the store it deploys itself (host on the overlay). */
function managedDsn(password: string): string {
  return `http://default:${encodeURIComponent(password)}@clickhouse:${CLICKHOUSE_HTTP_PORT}/otel`;
}

function endpointSummary(dsn: string | null): string | null {
  if (!dsn) return null;
  try {
    return new URL(dsn).host;
  } catch {
    return null;
  }
}

function toView(row: ObsConfigRow): ObservabilityConfigView {
  return {
    enabled: row.enabled,
    collectorStatus: (row.collectorStatus as CollectorStatus) ?? 'OFFLINE',
    retentionDays: row.retentionDays,
    storeConfigured: Boolean(row.clickhouseDsn),
    storeEndpoint: endpointSummary(row.clickhouseDsn ? safeDecrypt(row.clickhouseDsn) : null),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function safeDecrypt(blob: string): string {
  try {
    return decryptSecret(blob);
  } catch {
    return blob;
  }
}

/* ----------------------------------------------------------------------------
 * Config + lifecycle
 * ------------------------------------------------------------------------- */

export async function getConfig(ctx: OrgContext): Promise<ObservabilityConfigView> {
  const row = await ensureConfig(ctx);
  return toView(row);
}

export async function getStatus(ctx: OrgContext): Promise<ObservabilityStatusView> {
  const row = await ensureConfig(ctx);
  const base = toView(row);
  // Opted-in stacks are Docker truth: count distinct stacks whose live services
  // carry the `swarmy.otel.enabled` label (never a DB column).
  const stacksEnabled = enabledStacks(ctx).size;
  let storeReachable = false;
  if (row.clickhouseDsn) {
    storeReachable = await pingStore(safeDecrypt(row.clickhouseDsn));
  }
  return { ...base, storeReachable, stacksEnabled };
}

/**
 * Turn the suite on/off. Enabling deploys an `otel-collector` + `clickhouse`
 * managed stack through the EXISTING `service.deploy` dispatch path and records
 * the generated store DSN (encrypted) so the read path can reach ClickHouse.
 */
export async function setEnabled(
  ctx: OrgContext,
  enabled: boolean,
): Promise<ObservabilityConfigView> {
  const existing = await ensureConfig(ctx);

  if (!enabled) {
    await teardownStore(ctx).catch(() => undefined);
    const row = await obsDb(ctx).update({
      where: { orgId: ctx.activeOrgId },
      data: { enabled: false, collectorStatus: 'OFFLINE' },
    });
    await writeAudit(ctx, { action: 'observability.disable', targetType: 'org', targetId: ctx.activeOrgId });
    return toView(row);
  }

  // Generate a store credential once and keep it stable across re-enables.
  const dsnPlain = existing.clickhouseDsn
    ? safeDecrypt(existing.clickhouseDsn)
    : managedDsn(randomPassword());

  await obsDb(ctx).update({
    where: { orgId: ctx.activeOrgId },
    data: {
      enabled: true,
      collectorStatus: 'DEPLOYING',
      clickhouseDsn: encryptSecret(dsnPlain),
    },
  });

  try {
    await deployStore(ctx, dsnPlain);
    const row = await obsDb(ctx).update({
      where: { orgId: ctx.activeOrgId },
      data: { collectorStatus: 'RUNNING' },
    });
    await writeAudit(ctx, {
      action: 'observability.enable',
      targetType: 'org',
      targetId: ctx.activeOrgId,
      metadata: { retentionDays: row.retentionDays },
    });
    return toView(row);
  } catch (e) {
    await obsDb(ctx).update({
      where: { orgId: ctx.activeOrgId },
      data: { collectorStatus: 'FAILED' },
    });
    throw mapDispatchError(e);
  }
}

export async function setRetention(
  ctx: OrgContext,
  retentionDays: number,
): Promise<ObservabilityConfigView> {
  await ensureConfig(ctx);
  const row = await obsDb(ctx).update({
    where: { orgId: ctx.activeOrgId },
    data: { retentionDays },
  });
  await writeAudit(ctx, {
    action: 'observability.setRetention',
    targetType: 'org',
    targetId: ctx.activeOrgId,
    metadata: { retentionDays },
  });
  return toView(row);
}

/* ----------------------------------------------------------------------------
 * Per-stack opt-in — Docker truth (a `swarmy.otel.enabled` service label).
 * ------------------------------------------------------------------------- */

/** Live services belonging to a stack, by its Docker stack-namespace label. */
function liveStackServices(ctx: OrgContext, stackName: string): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services.filter((s) => s.stack === stackName);
}

/** Distinct stack names whose live services carry the otel opt-in label. */
function enabledStacks(ctx: OrgContext): Set<string> {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return new Set(
    buildInventory(services, containers)
      .services.filter((s) => s.stack !== UNGROUPED && s.labels[OTEL_ENABLED_LABEL] === 'true')
      .map((s) => s.stack),
  );
}

/**
 * Read the per-stack opt-in straight from Docker: a stack is telemetry-enabled
 * when any of its live services carries `swarmy.otel.enabled=true`. Pure read of
 * the in-memory inventory — the deploy path calls this to decide OTEL injection.
 */
export function stackTelemetryEnabled(ctx: OrgContext, stack: string): boolean {
  return liveStackServices(ctx, stack).some((s) => s.labels[OTEL_ENABLED_LABEL] === 'true');
}

/**
 * Flip the per-stack opt-in by stamping/clearing the `swarmy.otel.enabled` label
 * on every live service in the stack (Docker truth). The label is read back at
 * deploy time so a subsequent redeploy (un)injects OTEL_* env. `stackId` is a
 * Stack config-row id OR the stack name (label-only stacks surface their name as
 * id) — both resolve to the Docker stack-namespace value.
 */
export async function enableForStack(
  ctx: OrgContext,
  input: { stackId: string; enabled: boolean },
): Promise<{ id: string; enabled: boolean }> {
  const row = await ctx.db.stack.findFirst({
    where: { id: input.stackId, orgId: ctx.activeOrgId },
    select: { id: true, name: true },
  });
  const stackName = row?.name ?? input.stackId;

  const services = liveStackServices(ctx, stackName);
  if (!row && services.length === 0) throw notFound('stack', input.stackId);

  const node = await resolveManagerNode(ctx);
  try {
    for (const svc of services) {
      await ctx.hub.dispatch(node.id, 'service.updateLabels', {
        service: svc.name,
        add: input.enabled ? { [OTEL_ENABLED_LABEL]: 'true' } : {},
        removeKeys: input.enabled ? [] : [OTEL_ENABLED_LABEL],
      });
    }
  } catch (e) {
    throw mapDispatchError(e);
  }

  await writeAudit(ctx, {
    action: input.enabled ? 'observability.stack.enable' : 'observability.stack.disable',
    targetType: 'stack',
    targetId: row?.id ?? stackName,
    metadata: { stack: stackName },
  });
  return { id: input.stackId, enabled: input.enabled };
}

/* ----------------------------------------------------------------------------
 * Reads — query ClickHouse over HTTP. Empty + status if not configured.
 * ------------------------------------------------------------------------- */

export interface TracesResult {
  status: 'ok' | 'disabled' | 'unreachable';
  traces: TraceRow[];
}

export interface MetricsResult {
  status: 'ok' | 'disabled' | 'unreachable';
  points: MetricsPoint[];
}

export interface TraceDetailResult {
  status: 'ok' | 'disabled' | 'unreachable' | 'not_found';
  spans: SpanRow[];
}

export interface MetricsSummaryResult {
  status: 'ok' | 'disabled' | 'unreachable';
  rows: MetricsSummaryRow[];
}

export async function traces(
  ctx: OrgContext,
  query: TracesQueryInput,
): Promise<TracesResult> {
  const dsn = await activeDsn(ctx);
  if (!dsn) return { status: 'disabled', traces: [] };
  const sql = buildTracesQuery(ctx.activeOrgId, query);
  const rows = await clickhouseJson<TraceRow>(dsn, sql);
  if (rows === null) return { status: 'unreachable', traces: [] };
  return { status: 'ok', traces: rows };
}

export async function metricsSeries(
  ctx: OrgContext,
  query: MetricsQueryInput,
): Promise<MetricsResult> {
  const dsn = await activeDsn(ctx);
  if (!dsn) return { status: 'disabled', points: [] };
  const sql = buildMetricsSeriesQuery(ctx.activeOrgId, query);
  const rows = await clickhouseJson<MetricsPoint>(dsn, sql);
  if (rows === null) return { status: 'unreachable', points: [] };
  return { status: 'ok', points: rows };
}

/** Full span tree for one trace (the waterfall view). Org-scoped. */
export async function traceDetail(
  ctx: OrgContext,
  query: TraceDetailQueryInput,
): Promise<TraceDetailResult> {
  const dsn = await activeDsn(ctx);
  if (!dsn) return { status: 'disabled', spans: [] };
  const sql = buildTraceDetailQuery(ctx.activeOrgId, query);
  const rows = await clickhouseJson<SpanRow>(dsn, sql);
  if (rows === null) return { status: 'unreachable', spans: [] };
  if (rows.length === 0) return { status: 'not_found', spans: [] };
  return { status: 'ok', spans: rows };
}

/** Per-service aggregate of a metric (dashboard panel). Org-scoped. */
export async function metricsSummary(
  ctx: OrgContext,
  query: MetricsSummaryQueryInput,
): Promise<MetricsSummaryResult> {
  const dsn = await activeDsn(ctx);
  if (!dsn) return { status: 'disabled', rows: [] };
  const sql = buildMetricsSummaryQuery(ctx.activeOrgId, query);
  const rows = await clickhouseJson<MetricsSummaryRow>(dsn, sql);
  if (rows === null) return { status: 'unreachable', rows: [] };
  return { status: 'ok', rows };
}

/* ----------------------------------------------------------------------------
 * Internals
 * ------------------------------------------------------------------------- */

async function activeDsn(ctx: OrgContext): Promise<string | null> {
  const row = await obsDb(ctx).findUnique({ where: { orgId: ctx.activeOrgId } });
  if (!row || !row.enabled || !row.clickhouseDsn) return null;
  return safeDecrypt(row.clickhouseDsn);
}

/**
 * Deploy the collector + ClickHouse through the shared `service.deploy` path.
 *
 * Order matters:
 *  1. Write the rendered collector `config.yaml` + ClickHouse init DDL to the
 *     manager host (via the existing `applyIngress` file-write capability) so the
 *     services' bind mounts resolve.
 *  2. Deploy ClickHouse, then the collector (which depends on the store).
 *  3. Replay the init DDL over the ClickHouse HTTP interface as a belt-and-braces
 *     step (idempotent `CREATE ... IF NOT EXISTS`), so tables/TTLs exist even if
 *     the entrypoint init dir was skipped (e.g. a re-used data volume).
 */
async function deployStore(ctx: OrgContext, dsnPlain: string): Promise<void> {
  const node = await resolveManagerNode(ctx);
  const dsn = parseDsn(dsnPlain);
  const retentionDays = await retentionFor(ctx);

  // 1. Write config files for the bind mounts (reuses the agent file-writer).
  const files = observabilityConfigFiles({
    password: dsn.password,
    retentionDays,
    database: dsn.database,
  });
  await ctx.hub.dispatch(node.id, 'applyIngress', {
    rendered: {
      driver: 'observability-files',
      files,
      serviceLabels: [],
    },
  });

  // 2. Deploy the store, then the collector.
  const specs: ServiceSpec[] = [
    clickhouseServiceSpec({ password: dsn.password, retentionDays }),
    collectorServiceSpec({ clickhouseDsn: dsnPlain }),
  ];
  for (const spec of specs) {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'missing' });
  }

  // 3. Replay the idempotent init DDL over HTTP (best-effort; store may still be
  //    booting on first enable — the entrypoint init covers that case).
  const initSql = renderClickhouseInitSql({ database: dsn.database, retentionDays });
  await applyInitDdl(dsnPlain, initSql).catch(() => undefined);
}

/** Run multi-statement init DDL over ClickHouse HTTP (statement by statement). */
async function applyInitDdl(dsnPlain: string, sql: string): Promise<void> {
  const statements = sql
    .split(';')
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await clickhouseExec(dsnPlain, stmt);
  }
}

async function teardownStore(ctx: OrgContext): Promise<void> {
  const node = await resolveManagerNode(ctx).catch(() => null);
  if (!node) return;
  for (const name of ['swarmy-otel-collector', 'swarmy-clickhouse']) {
    await ctx.hub.dispatch(node.id, 'service.remove', { service: name }).catch(() => undefined);
  }
}

async function retentionFor(ctx: OrgContext): Promise<number> {
  const row = await obsDb(ctx).findUnique({ where: { orgId: ctx.activeOrgId } });
  return row?.retentionDays ?? DEFAULT_RETENTION_DAYS;
}

function randomPassword(): string {
  return randomBytes(18).toString('base64url');
}

function authHeader(dsn: ClickhouseDsn): Record<string, string> {
  return {
    'X-ClickHouse-User': dsn.user,
    'X-ClickHouse-Key': dsn.password,
  };
}

/** Probe the ClickHouse HTTP `/ping` endpoint. */
async function pingStore(dsnPlain: string): Promise<boolean> {
  try {
    const dsn = parseDsn(dsnPlain);
    const res = await fetch(`${dsn.baseUrl}/ping`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Run a single non-SELECT statement (DDL) against ClickHouse HTTP. */
async function clickhouseExec(dsnPlain: string, sql: string): Promise<void> {
  const dsn = parseDsn(dsnPlain);
  const url = new URL(dsn.baseUrl);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { ...authHeader(dsn), 'Content-Type': 'text/plain' },
    body: sql,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`clickhouse exec failed (${res.status}): ${await res.text().catch(() => '')}`);
  }
}

/**
 * Run a SQL query against ClickHouse HTTP, asking for JSONEachRow output.
 * Returns the parsed rows, or `null` if the store is unreachable / errored.
 */
async function clickhouseJson<T>(dsnPlain: string, sql: string): Promise<T[] | null> {
  let dsn: ClickhouseDsn;
  try {
    dsn = parseDsn(dsnPlain);
  } catch {
    return null;
  }
  const url = new URL(dsn.baseUrl);
  url.searchParams.set('database', dsn.database);
  url.searchParams.set('default_format', 'JSONEachRow');
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { ...authHeader(dsn), 'Content-Type': 'text/plain' },
      body: sql,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim()) return [];
    return text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as T);
  } catch {
    return null;
  }
}

export { OTEL_OVERLAY_NETWORK };

/* ----------------------------------------------------------------------------
 * ── logs (C1)
 * ------------------------------------------------------------------------- */

import { buildLogsQuery } from './observability-query';
import type { LogRowView, ObservabilityLogsInput, ObservabilityLogsPage } from '@swarmy/core';

const LOGS_DEFAULT_LIMIT = 200;
const LOGS_MAX_LIMIT = 500;

/**
 * Structured logs from `otel_logs`, newest first, timestamp-cursor paginated.
 * Same fail-open `{status}` contract as the other reads: `disabled` when the
 * suite is off / no store DSN, `unreachable` when ClickHouse doesn't answer.
 * Org-scoping happens inside `buildLogsQuery` (the `swarmy.org_id` predicate
 * is always present). Pure read — no audit row.
 */
export async function logs(
  ctx: OrgContext,
  query: ObservabilityLogsInput,
): Promise<ObservabilityLogsPage> {
  const dsn = await activeDsn(ctx);
  if (!dsn) return { status: 'disabled', rows: [], nextCursor: null };
  const sql = buildLogsQuery(ctx.activeOrgId, query);
  const rows = await clickhouseJson<LogRowView>(dsn, sql);
  if (rows === null) return { status: 'unreachable', rows: [], nextCursor: null };
  const limit = Math.min(Math.max(query.limit ?? LOGS_DEFAULT_LIMIT, 1), LOGS_MAX_LIMIT);
  // A full page means there may be older rows: hand back the last row's
  // nanosecond timestamp as the keyset cursor for the next page.
  const nextCursor = rows.length >= limit ? (rows[rows.length - 1]?.ts_nano ?? null) : null;
  return { status: 'ok', rows, nextCursor };
}

/* ----------------------------------------------------------------------------
 * ── map+health (C2)
 * ------------------------------------------------------------------------- */

import {
  buildServiceMapNodesQuery,
  buildServiceMapQuery,
  composeServiceMap,
  MAP_DEFAULT_WINDOW_MINUTES,
  type ServiceMapEdgeRow,
  type ServiceMapNodeRow,
} from './observability-map';
import type { ObservabilityMapInput, ServiceMapView } from '@swarmy/core';

/**
 * The service map (`observability.map`): nodes = services with entry spans in
 * the window, edges = client→server span-kind pairs, both with RED aggregates.
 * Same fail-open `{status}` contract as the other reads. Org-scoping happens
 * inside the SQL builders (both join sides). Pure read — no audit row.
 */
export async function serviceMap(ctx: OrgContext, q: ObservabilityMapInput): Promise<ServiceMapView> {
  const windowMinutes = q.windowMinutes ?? MAP_DEFAULT_WINDOW_MINUTES;
  const dsn = await activeDsn(ctx);
  if (!dsn) return { status: 'disabled', windowMinutes, nodes: [], edges: [] };
  const [nodeRows, edgeRows] = await Promise.all([
    clickhouseJson<ServiceMapNodeRow>(dsn, buildServiceMapNodesQuery(ctx.activeOrgId, { windowMinutes })),
    clickhouseJson<ServiceMapEdgeRow>(dsn, buildServiceMapQuery(ctx.activeOrgId, { windowMinutes })),
  ]);
  if (nodeRows === null || edgeRows === null) {
    return { status: 'unreachable', windowMinutes, nodes: [], edges: [] };
  }
  return { status: 'ok', windowMinutes, ...composeServiceMap(nodeRows, edgeRows, windowMinutes) };
}

/**
 * RED + collector/store snapshot for the health narrative (`health-summary.ts`):
 * per-service p95/error-rate over entry spans, plus whether the suite is on and
 * the store answered. Never upserts config (safe from worker/system contexts);
 * a missing row simply reads as disabled.
 */
export interface RedSnapshot {
  enabled: boolean;
  collectorStatus: CollectorStatus;
  /** True when ClickHouse answered the RED query on this snapshot. */
  reachable: boolean;
  rows: ServiceMapNodeRow[];
  windowMinutes: number;
}

export async function redSnapshot(
  ctx: OrgContext,
  windowMinutes: number = MAP_DEFAULT_WINDOW_MINUTES,
): Promise<RedSnapshot> {
  const row = await obsDb(ctx)
    .findUnique({ where: { orgId: ctx.activeOrgId } })
    .catch(() => null);
  const enabled = Boolean(row?.enabled);
  const collectorStatus = (row?.collectorStatus as CollectorStatus) ?? 'OFFLINE';
  if (!row || !enabled || !row.clickhouseDsn) {
    return { enabled, collectorStatus, reachable: false, rows: [], windowMinutes };
  }
  const rows = await clickhouseJson<ServiceMapNodeRow>(
    safeDecrypt(row.clickhouseDsn),
    buildServiceMapNodesQuery(ctx.activeOrgId, { windowMinutes }),
  );
  if (rows === null) return { enabled, collectorStatus, reachable: false, rows: [], windowMinutes };
  return { enabled, collectorStatus, reachable: true, rows, windowMinutes };
}
