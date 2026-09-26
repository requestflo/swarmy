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
 *  - Run state is never stored (epic-docker-native-state P1): the collector /
 *    store status is derived from live tasks, the deploy outcome is held in
 *    memory ({@link suiteRuns}), and the store probe the reconcile worker takes
 *    lives in memory too ({@link recordStoreProbe}). After a controller restart
 *    the next tick re-derives all of it.
 *
 * `ObservabilityConfig` lives in the org's swarm (swarm-kv `obs/<orgId>`, via
 * {@link observabilityConfigRepo}); the DSN is vault-encrypted inside it.
 */
import { stacks } from './apps.repo';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { randomBytes } from 'node:crypto';
import {
  buildInventory,
  clickhouseClient,
  parseClickhouseDsn,
  SWARMY_CONTROL_NETWORK,
  UNGROUPED,
  type ClickhouseTarget,
  type InvService,
} from '@swarmy/core';
import { encryptSecret, decryptSecret } from '@swarmy/core/crypto';
import { defaultTelemetrySettings, type TelemetrySettings } from '@swarmy/core';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { observabilityConfigRepo, type ObservabilityConfigRow } from './observability-config.repo';
import { mapDispatchError, notFound } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { ensureControlNetwork } from './platform-networks';
import { OTEL_ENABLED_LABEL } from './otel-injection';
import {
  collectorServiceSpec,
  clickhouseServiceSpec,
  deriveSuiteServiceStatus,
  observabilityConfigs,
  observabilityNeedsConverge,
  resolveStorePin,
  staleObservabilityConfigs,
  staleObservabilitySecrets,
  CLICKHOUSE_HTTP_PORT,
  CLICKHOUSE_NODE_LABEL,
  CLICKHOUSE_SERVICE,
  CLICKHOUSE_SERVICE_HOST,
  COLLECTOR_SERVICE,
  OBS_CONFIG_LABEL,
  OBS_SECRET_LABEL,
  OTEL_OVERLAY_NETWORK,
  type ObservabilityConfigObject,
  type ObservabilityConfigSet,
  type ObservabilitySecretObject,
} from './observability-stack';
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
  /** Live ClickHouse service status (running tasks), same derivation as the collector. */
  storeStatus: CollectorStatus;
  stacksEnabled: number;
}

/* ----------------------------------------------------------------------------
 * Narrow DB view of the new models (removed once the client is regenerated).
 * ------------------------------------------------------------------------- */

type ObsConfigRow = ObservabilityConfigRow;

const DEFAULT_RETENTION_DAYS = 7;

/** The org's observability config (swarm-kv; defaults: off, 7-day retention — a read never writes). */
async function ensureConfig(ctx: OrgContext): Promise<ObsConfigRow> {
  return observabilityConfigRepo.get(ctx, ctx.activeOrgId);
}

/** A ClickHouse DSN, e.g. `http://default:pw@swarmy-clickhouse:8123/otel` (legacy hosts healed on parse). */
type ClickhouseDsn = ClickhouseTarget;
const parseDsn = parseClickhouseDsn;

/** The DSN swarmy uses for the store it deploys itself (host on the overlay). */
function managedDsn(password: string): string {
  return `http://default:${encodeURIComponent(password)}@${CLICKHOUSE_SERVICE_HOST}:${CLICKHOUSE_HTTP_PORT}/otel`;
}

function endpointSummary(dsn: string | null): string | null {
  if (!dsn) return null;
  try {
    return new URL(dsn).host;
  } catch {
    return null;
  }
}

/**
 * The last suite deploy this process dispatched, per org: when it was
 * requested (anchors the start grace) and whether the dispatch itself failed.
 * Process-local run state, never persisted: after a restart the grace anchors
 * on the config row's `updatedAt` and live tasks decide the rest.
 */
const suiteRuns = new Map<string, { requestedAt: number; failed: boolean }>();

function markSuiteDeploy(orgId: string, failed: boolean): void {
  suiteRuns.set(orgId, { requestedAt: Date.now(), failed });
}

/** A store probe taken by the observability reconcile worker (in memory only). */
export interface StoreProbe {
  reachable: boolean;
  diskUsedBytes: bigint;
  checkedAt: Date;
}

const storeProbes = new Map<string, StoreProbe>();

/** Record the latest ClickHouse probe for an org (reconcile worker). */
export function recordStoreProbe(orgId: string, probe: StoreProbe): void {
  storeProbes.set(orgId, probe);
}

/** The latest ClickHouse probe for an org, or null before the first tick. */
export function latestStoreProbe(orgId: string): StoreProbe | null {
  return storeProbes.get(orgId) ?? null;
}

/**
 * Live collector/store status from Docker truth — running tasks on the live
 * inventory, never an optimistic value recorded at deploy time. The in-memory
 * deploy record only contributes "when was it requested" (start grace) and
 * "did the dispatch itself fail".
 */
export function liveSuiteStatus(
  ctx: OrgContext,
  row: Pick<ObsConfigRow, 'enabled' | 'updatedAt'>,
): { collector: CollectorStatus; store: CollectorStatus } {
  const services = ctx.hub.liveInventory(ctx.activeOrgId).services;
  const run = suiteRuns.get(ctx.activeOrgId);
  const base = {
    enabled: row.enabled,
    requestedAt: run?.requestedAt ?? row.updatedAt.getTime(),
    deployFailed: Boolean(run?.failed),
    now: Date.now(),
  };
  return {
    collector: deriveSuiteServiceStatus({
      ...base,
      service: services.find((s) => s.name === COLLECTOR_SERVICE),
    }),
    store: deriveSuiteServiceStatus({
      ...base,
      service: services.find((s) => s.name === CLICKHOUSE_SERVICE),
    }),
  };
}

function toView(ctx: OrgContext, row: ObsConfigRow): ObservabilityConfigView {
  return {
    enabled: row.enabled,
    collectorStatus: liveSuiteStatus(ctx, row).collector,
    retentionDays: row.retentionDays,
    storeConfigured: Boolean(row.clickhouseDsn),
    storeEndpoint: endpointSummary(row.clickhouseDsn ? safeDecrypt(row.clickhouseDsn) : null),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function safeDecrypt(blob: string): string {
  try {
    return decryptSecret(blob);
  } catch {
    return blob;
  }
}

/* ----------------------------------------------------------------------------
 * Config + lifecycle
 * ------------------------------------------------------------------------- */

export async function getStatus(ctx: OrgContext): Promise<ObservabilityStatusView> {
  const row = await ensureConfig(ctx);
  const base = toView(ctx, row);
  const storeStatus = liveSuiteStatus(ctx, row).store;
  // Opted-in stacks are Docker truth: count distinct stacks whose live services
  // carry the `swarmy.otel.enabled` label (never a DB column).
  const stacksEnabled = enabledStacks(ctx).size;
  let storeReachable = false;
  if (row.clickhouseDsn) {
    storeReachable = await pingStore(safeDecrypt(row.clickhouseDsn));
  }
  return { ...base, storeReachable, storeStatus, stacksEnabled };
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
    const row = await observabilityConfigRepo.update(ctx, ctx.activeOrgId, { enabled: false });
    suiteRuns.delete(ctx.activeOrgId);
    await writeAudit(ctx, { action: 'observability.disable', targetType: 'org', targetId: ctx.activeOrgId });
    return toView(ctx, row);
  }

  // Generate a store credential once and keep it stable across re-enables.
  const dsnPlain = existing.clickhouseDsn
    ? safeDecrypt(existing.clickhouseDsn)
    : managedDsn(randomPassword());

  await observabilityConfigRepo.update(ctx, ctx.activeOrgId, {
    enabled: true,
    clickhouseDsn: encryptSecret(dsnPlain),
  });

  try {
    markSuiteDeploy(ctx.activeOrgId, false);
    await deployStore(ctx, dsnPlain);
    // Dispatched, not yet running: the view derives RUNNING from live tasks.
    const row = await ensureConfig(ctx);
    await writeAudit(ctx, {
      action: 'observability.enable',
      targetType: 'org',
      targetId: ctx.activeOrgId,
      metadata: { retentionDays: row.retentionDays },
    });
    return toView(ctx, row);
  } catch (e) {
    markSuiteDeploy(ctx.activeOrgId, true);
    throw mapDispatchError(e);
  }
}

export async function setRetention(
  ctx: OrgContext,
  retentionDays: number,
): Promise<ObservabilityConfigView> {
  await ensureConfig(ctx);
  // Keep saved per-signal settings in step: the single number is traces + logs.
  const row = await observabilityConfigRepo.update(ctx, ctx.activeOrgId, (cur) => ({
    retentionDays,
    ...(cur.telemetry
      ? { telemetry: { ...cur.telemetry, retention: { ...cur.telemetry.retention, tracesDays: retentionDays, logsDays: retentionDays } } }
      : {}),
  }));
  await writeAudit(ctx, {
    action: 'observability.setRetention',
    targetType: 'org',
    targetId: ctx.activeOrgId,
    metadata: { retentionDays },
  });
  return toView(ctx, row);
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
  const row = await stacks(ctx, ctx.activeOrgId).findFirst({
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

/**
 * The org's ClickHouse store for OTHER swarmy features that keep history next
 * to its telemetry (the email send log): the plaintext DSN + retention, or
 * null while the suite is off. Server-side only — never return the DSN.
 */
export async function observabilityStore(ctx: OrgContext): Promise<{ dsn: string; retentionDays: number } | null> {
  const dsn = await activeDsn(ctx);
  return dsn ? { dsn, retentionDays: await retentionFor(ctx) } : null;
}

async function activeDsn(ctx: OrgContext): Promise<string | null> {
  const row = await observabilityConfigRepo.find(ctx, ctx.activeOrgId);
  if (!row || !row.enabled || !row.clickhouseDsn) return null;
  return safeDecrypt(row.clickhouseDsn);
}

/**
 * Deploy the collector + ClickHouse through the shared `service.deploy` path.
 *
 * Order matters:
 *  1. Create the rendered collector `config.yaml` + ClickHouse init DDL as
 *     swarm Docker CONFIGS (content-addressed, so re-creating the same render
 *     is a no-op) — the managers replicate them to whichever node a task lands
 *     on. No host files, so any topology / containerised agent works.
 *  2. Deploy ClickHouse (pinned to one node: its data volume is node-local),
 *     then the collector. A deploy onto an existing service is a full spec
 *     update, so legacy bind-mount specs converge here too.
 *  3. Sweep superseded observability configs (best-effort; an in-use config
 *     refuses removal and is retried on the next converge).
 *  4. Replay the init DDL over the ClickHouse HTTP interface as a belt-and-braces
 *     step (idempotent `CREATE ... IF NOT EXISTS`), so the database exists even
 *     if the entrypoint init dir was skipped (e.g. a re-used data volume).
 */
async function deployStore(ctx: OrgContext, dsnPlain: string): Promise<void> {
  const node = await resolveManagerNode(ctx);
  const dsn = parseDsn(dsnPlain);
  const row = await ensureConfig(ctx);
  const retentionDays = row.retentionDays;
  const configs = desiredConfigs(dsn, row);

  // 1. Docker secret + configs first — the specs reference them by name. The
  //    password rides ONLY in the secret; the configs carry no secret material.
  await createSecretIdempotent(ctx, node.id, configs.clickhousePassword);
  for (const cfg of [configs.clickhouseInit, configs.collector]) {
    await createConfigIdempotent(ctx, node.id, cfg);
  }

  // 2. Deploy the store (pinned), then the collector. The store lives on the
  //    private control network (created here for pre-split installs).
  await ensureControlNetwork(ctx, node.id);
  const specs: ServiceSpec[] = [
    clickhouseServiceSpec({
      passwordSecret: configs.clickhousePassword.name,
      retentionDays,
      initConfig: configs.clickhouseInit.name,
      pinSwarmNodeId: storePin(ctx, node.id),
      controllerOnSharedOnly: controllerOnSharedOnly(ctx),
    }),
    collectorServiceSpec({ passwordSecret: configs.clickhousePassword.name, config: configs.collector.name }),
  ];
  for (const spec of specs) {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'missing' });
  }

  // 3. Drop superseded configs (incl. legacy ones that embedded the password)
  //    and secrets now that no spec references them.
  await sweepStaleConfigs(ctx, node.id, [configs.clickhouseInit.name, configs.collector.name]);
  await sweepStaleSecrets(ctx, node.id, [configs.clickhousePassword.name]);

  // 4. Replay the idempotent init DDL over HTTP (best-effort; store may still be
  //    booting on first enable — the entrypoint init covers that case).
  await applyInitDdl(dsnPlain, configs.clickhouseInit.contents).catch(() => undefined);
}

/** The org's telemetry settings: saved, or the defaults over its single retention. */
export function telemetrySettingsFor(row: Pick<ObsConfigRow, 'telemetry' | 'retentionDays'>): TelemetrySettings {
  return row.telemetry ?? defaultTelemetrySettings(row.retentionDays);
}

export function desiredConfigs(
  dsn: ClickhouseDsn,
  row: Pick<ObsConfigRow, 'telemetry' | 'retentionDays'>,
): ObservabilityConfigSet {
  return observabilityConfigs({
    password: dsn.password,
    retentionDays: row.retentionDays,
    database: dsn.database,
    telemetry: telemetrySettingsFor(row),
  });
}

/** Where ClickHouse is pinned: its existing pin label, else the dispatch manager. */
/**
 * True while the controller service runs but is not yet on `swarmy-control`
 * (pre-split install whose stack file hasn't been re-deployed). Unknown
 * (not in this org's inventory, e.g. a dev controller on the host) = false.
 */
function controllerOnSharedOnly(ctx: OrgContext): boolean {
  const ctl = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === 'swarmy_controller');
  if (!ctl) return false;
  return !ctl.networks.some((n) => n.name === SWARMY_CONTROL_NETWORK);
}

function storePin(ctx: OrgContext, managerNodeId: string): string | undefined {
  const live = ctx.hub
    .liveInventory(ctx.activeOrgId)
    .services.find((s) => s.name === CLICKHOUSE_SERVICE);
  return resolveStorePin({
    labelled: live?.labels[CLICKHOUSE_NODE_LABEL],
    managerSwarmNodeId: ctx.hub.swarmNodeIdFor(managerNodeId),
    knownSwarmNodeIds: new Set(
      ctx.hub.nodeInventory(ctx.activeOrgId, true).map((n) => n.swarmNodeId),
    ),
  });
}

/** `config.create`, tolerating "already exists" (content-addressed ⇒ same bytes). */
async function createConfigIdempotent(
  ctx: OrgContext,
  nodeId: string,
  cfg: ObservabilityConfigObject,
): Promise<void> {
  try {
    await ctx.hub.dispatch(nodeId, 'config.create', {
      name: cfg.name,
      dataB64: Buffer.from(cfg.contents, 'utf8').toString('base64'),
      labels: { 'swarmy.managed': 'true', [OBS_CONFIG_LABEL]: 'true' },
    });
  } catch (e) {
    if (!/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
}

/** `secret.create`, tolerating "already exists" (content-addressed ⇒ same value). */
async function createSecretIdempotent(
  ctx: OrgContext,
  nodeId: string,
  secret: ObservabilitySecretObject,
): Promise<void> {
  try {
    await ctx.hub.dispatch(nodeId, 'secret.create', {
      name: secret.name,
      dataB64: Buffer.from(secret.value, 'utf8').toString('base64'),
      labels: { 'swarmy.managed': 'true', [OBS_SECRET_LABEL]: 'true' },
    });
  } catch (e) {
    if (!/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
}

/** Best-effort removal of observability secrets not in `keep`. */
async function sweepStaleSecrets(ctx: OrgContext, nodeId: string, keep: string[]): Promise<void> {
  try {
    const res = await ctx.hub.dispatch<{ secrets?: Array<{ name: string }> }>(nodeId, 'secret.list', {});
    for (const name of staleObservabilitySecrets((res.secrets ?? []).map((s) => s.name), keep)) {
      await ctx.hub.dispatch(nodeId, 'secret.remove', { name }).catch(() => undefined);
    }
  } catch {
    // best-effort — an in-use secret refuses removal; retried on the next converge.
  }
}

/** Best-effort removal of observability configs not in `keep`. */
async function sweepStaleConfigs(ctx: OrgContext, nodeId: string, keep: string[]): Promise<void> {
  try {
    const res = await ctx.hub.dispatch<{ configs?: Array<{ name: string }> }>(nodeId, 'config.list', {});
    const stale = staleObservabilityConfigs((res.configs ?? []).map((c) => c.name), keep);
    for (const name of stale) {
      await ctx.hub.dispatch(nodeId, 'config.remove', { name }).catch(() => undefined);
    }
  } catch {
    // best-effort — retried on the next converge / teardown.
  }
}

/**
 * Converge the deployed suite onto the current render (reconcile worker hook).
 * Redeploys when a service is missing, still carries a legacy host bind mount,
 * references a stale config, or has lost/moved its store pin — so deployments
 * made with the old bind-mount specs heal on the next tick. No-op when the suite
 * is off or already converged. Returns whether a redeploy was dispatched.
 */
const CONVERGE_COOLDOWN_MS = 5 * 60_000;
const lastConvergeAt = new Map<string, number>();

export async function reconcileObservabilitySuite(
  ctx: OrgContext,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const row = await observabilityConfigRepo.find(ctx, ctx.activeOrgId);
  if (!row?.enabled || !row.clickhouseDsn) return false;
  const managerId = ctx.hub.managerNode(ctx.activeOrgId);
  if (!managerId) return false;
  const dsnPlain = safeDecrypt(row.clickhouseDsn);
  const services = ctx.hub.liveInventory(ctx.activeOrgId).services;
  const needs = observabilityNeedsConverge({
    store: services.find((s) => s.name === CLICKHOUSE_SERVICE),
    collector: services.find((s) => s.name === COLLECTOR_SERVICE),
    desired: desiredConfigs(parseDsn(dsnPlain), row),
    desiredPin: storePin(ctx, managerId),
  });
  if (!needs) return false;
  // Throttle: a converge that cannot take (e.g. an older agent that does not
  // report configs/mounts) must not redeploy every worker tick.
  const now = Date.now();
  // A human "Apply" (force) skips the throttle; the worker never does.
  if (!opts.force && now - (lastConvergeAt.get(ctx.activeOrgId) ?? 0) < CONVERGE_COOLDOWN_MS) return false;
  lastConvergeAt.set(ctx.activeOrgId, now);
  const prior = suiteRuns.get(ctx.activeOrgId);
  try {
    await deployStore(ctx, dsnPlain);
    // Only re-anchor on a transition: the request time anchors the start
    // grace, so re-stamping it every tick would hide a service that never
    // comes up.
    if (!prior || prior.failed) markSuiteDeploy(ctx.activeOrgId, false);
  } catch (e) {
    markSuiteDeploy(ctx.activeOrgId, true);
    if (opts.force) throw mapDispatchError(e);
  }
  return true;
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
  for (const name of [COLLECTOR_SERVICE, CLICKHOUSE_SERVICE]) {
    await ctx.hub.dispatch(node.id, 'service.remove', { service: name }).catch(() => undefined);
  }
  // The rendered configs + password secret go with the services (zero footprint when off).
  await sweepStaleConfigs(ctx, node.id, []);
  await sweepStaleSecrets(ctx, node.id, []);
}

async function retentionFor(ctx: OrgContext): Promise<number> {
  const row = await observabilityConfigRepo.find(ctx, ctx.activeOrgId);
  return row?.retentionDays ?? DEFAULT_RETENTION_DAYS;
}

function randomPassword(): string {
  return randomBytes(18).toString('base64url');
}

/** Probe the ClickHouse HTTP `/ping` endpoint. */
async function pingStore(dsnPlain: string): Promise<boolean> {
  try {
    return await clickhouseClient(dsnPlain).ping();
  } catch {
    return false;
  }
}

/** Run a single non-SELECT statement (DDL) against ClickHouse HTTP. */
async function clickhouseExec(dsnPlain: string, sql: string): Promise<void> {
  await clickhouseClient(dsnPlain, { timeoutMs: 8000 }).exec(sql);
}

/**
 * Run a SQL query against ClickHouse HTTP (JSONEachRow). Returns the parsed
 * rows, or `null` if the store is unreachable / errored (reads fail open).
 */
async function clickhouseJson<T>(dsnPlain: string, sql: string): Promise<T[] | null> {
  try {
    return await clickhouseClient(dsnPlain, { timeoutMs: 8000 }).json<T>(sql);
  } catch {
    return null;
  }
}

export { OTEL_OVERLAY_NETWORK };

/* ----------------------------------------------------------------------------
 * ── logs (C1)
 * ------------------------------------------------------------------------- */

import { buildErrorRatesQuery, buildLogsQuery } from './observability-query';
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
  const row = await observabilityConfigRepo.find(ctx, ctx.activeOrgId).catch(() => null);
  const enabled = Boolean(row?.enabled);
  const collectorStatus: CollectorStatus = row ? liveSuiteStatus(ctx, row).collector : 'OFFLINE';
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

/* ----------------------------------------------------------------------------
 * ── shared store access (error tracking, epic-developer-platform §6)
 * ------------------------------------------------------------------------- */

/**
 * The org's ClickHouse store, for sibling writers that own their OWN tables in
 * the same database (error tracking's `swarmy_error_*`). Null when the suite
 * is off. Same credentials, same fail-open semantics: `query` returns null on
 * an unreachable store; `exec` / `insert` throw.
 */
export interface OrgClickhouse {
  database: string;
  retentionDays: number;
  query<T>(sql: string): Promise<T[] | null>;
  exec(sql: string): Promise<void>;
  /** Insert rows as a JSONEachRow body (values never enter SQL text). */
  insert(table: string, rows: object[]): Promise<void>;
}

export async function orgClickhouse(ctx: OrgContext): Promise<OrgClickhouse | null> {
  const row = await observabilityConfigRepo.find(ctx, ctx.activeOrgId).catch(() => null);
  if (!row || !row.enabled || !row.clickhouseDsn) return null;
  const dsnPlain = safeDecrypt(row.clickhouseDsn);
  let dsn: ClickhouseDsn;
  try {
    dsn = parseDsn(dsnPlain);
  } catch {
    return null;
  }
  return {
    database: dsn.database,
    retentionDays: row.retentionDays,
    query: <T>(sql: string) => clickhouseJson<T>(dsnPlain, sql),
    exec: (sql: string) => clickhouseExec(dsnPlain, sql),
    insert: (table: string, rows: object[]) => clickhouseClient(dsn).insert(table, rows),
  };
}

/** One service's span volume and error count over a window. */
export interface ServiceErrorRate {
  service: string;
  calls: number;
  errors: number;
}

/**
 * Per-OTel-service error counts from the org's store, or null when the suite
 * is off or the store is unreachable (callers treat null as "blind").
 */
export async function orgErrorRates(
  ctx: OrgContext,
  opts: { windowMinutes: number; entrySpansOnly?: boolean },
): Promise<ServiceErrorRate[] | null> {
  const ch = await orgClickhouse(ctx);
  if (!ch) return null;
  const rows = await ch.query<{ service: string; calls: number | string; errors: number | string }>(
    buildErrorRatesQuery(ctx.activeOrgId, opts),
  );
  return rows?.map((r) => ({ service: r.service, calls: Number(r.calls), errors: Number(r.errors) })) ?? null;
}
