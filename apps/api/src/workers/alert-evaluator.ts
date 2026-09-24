import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { ensureDefaultRules, fireEvent, latestStoreProbe, observabilityConfigRepo, recordIncidentEvent, systemContext } from '@swarmy/trpc';
import type { OrgContext } from '@swarmy/trpc';
import { ALERT_SIGNAL_INFO, type AlertSignal } from '@swarmy/core';
import { decryptSecret } from '@swarmy/core/crypto';
import { hub, store } from '../gateway';
import { forecastConditions, loadDiskSeries } from './disk-forecast-alerts';

/**
 * Alert evaluator worker (slice C3). Every 30s, per org, derive signal
 * conditions from live truth and fire/resolve `AlertEvent`s through the
 * `fireEvent` contract (which dedupes, honours mutes and notifies channels):
 *
 *   node-offline       enrolled node seen before, not connected now (default for 5 min)
 *   service-down       desired > running replicas (gated ~2 ticks)
 *   crash-loop         a service's recent task failures ≥ the rule threshold
 *                      (agent `taskHealth.recentFailures`, last 10 min)
 *   db-degraded        `swarmy.db.lag.<member>` above the rule threshold
 *   db-failover        `swarmy.db.leader` changed vs the previous tick (edge)
 *   backup-failed      a schedule's most recent BackupJob failed, OR an
 *                      unpaused schedule is overdue (missed its slot)
 *   disk-usage         node fs usage above the rule threshold
 *   queue-depth        `swarmy.queues.stats` wait above the rule threshold
 *   error-rate         ClickHouse span error-rate above threshold (store up)
 *   store-unreachable  observability enabled but the store stopped answering
 *
 * Every tick first runs `ensureDefaultRules` for the org, so the default
 * alert catalog is ON for every org without anyone opening the Alerts page
 * (idempotent; a user-deleted default is a tombstone and stays deleted).
 *
 * Fired by other slices (not evaluated here): cert-expiry (domain-verify
 * service, per certificate check), build-failed (cicd build path),
 * deploy-failed / deploy-rolled-back (deploy-safety + deploy-canary workers).
 *
 * For-duration gating and edge detection keep tick-to-tick state in module
 * maps (reset on controller restart — events themselves dedupe in the DB).
 * Label parsing mirrors `@swarmy/trpc` health-summary / queues.service (a
 * worker cannot subpath-import an internal trpc module — the same constraint
 * job-scheduler and manageddb-reconcile document).
 *
 * ORCHESTRATOR TODO: `sampleUptimeTick` (status pages, C5) and
 * `openOrResolveIncidents`-style resolution live behind the `@swarmy/trpc`
 * root export — once `sampleUptimeTick` is re-exported from
 * `packages/trpc/src/index.ts`, call it at the end of each tick.
 */

const TICK_MS = 30_000;

// ── Label mirrors (canonical: @swarmy/trpc health-summary / queues.service) ──
const STACK_LABEL = 'com.docker.stack.namespace';
const DB_CLUSTER_LABEL = 'swarmy.db.cluster';
const DB_LEADER_LABEL = 'swarmy.db.leader';
const DB_LAG_PREFIX = 'swarmy.db.lag.';
const QUEUES_STATS_LABEL = 'swarmy.queues.stats';

/** Minimum sampled calls before an error-rate condition can fire. */
const ERROR_RATE_MIN_CALLS = 20;
const ERROR_RATE_WINDOW_MIN = 5;
/** Disk usage at/above this is critical regardless of the rule threshold. */
export const DISK_CRITICAL_PCT = 95;
/** Grace past a backup schedule's `nextRunAt` before it counts as missed. */
export const BACKUP_MISSED_GRACE_MS = 60 * 60_000;

// ── Pure evaluation helpers (exported for unit tests) ────────────────────────

export interface Condition {
  signal: AlertSignal;
  resource: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
}

export const conditionKey = (c: Pick<Condition, 'signal' | 'resource'>): string =>
  `${c.signal}|${c.resource}`;

/**
 * For-duration gate. Mutates `pending` (key → first-seen ms): new keys start
 * their clock, vanished keys reset. Returns the conditions whose signal has
 * been continuously true for at least its `forSeconds`.
 */
export function gateConditions(
  pending: Map<string, number>,
  conditions: Condition[],
  forSeconds: (signal: AlertSignal) => number,
  now: number,
): Condition[] {
  const current = new Set(conditions.map(conditionKey));
  for (const key of pending.keys()) {
    if (!current.has(key)) pending.delete(key);
  }
  const ready: Condition[] = [];
  for (const c of conditions) {
    const key = conditionKey(c);
    const first = pending.get(key) ?? now;
    if (!pending.has(key)) pending.set(key, now);
    if (now - first >= Math.max(0, forSeconds(c.signal)) * 1000) ready.push(c);
  }
  return ready;
}

export function serviceDownConditions(
  services: Array<{ name: string; desired: number; running: number }>,
): Condition[] {
  const out: Condition[] = [];
  for (const s of services) {
    if (s.desired > 0 && s.running < s.desired) {
      out.push({
        signal: 'service-down',
        resource: `service:${s.name}`,
        severity: s.running === 0 ? 'critical' : 'warning',
        message: `Service ${s.name} is running ${s.running}/${s.desired} replicas`,
      });
    }
  }
  return out;
}

export function diskConditions(
  nodes: Array<{ name: string; usedBytes: number | null; totalBytes: number | null }>,
  thresholdPct: number,
): Condition[] {
  const out: Condition[] = [];
  for (const n of nodes) {
    if (!n.usedBytes || !n.totalBytes || n.totalBytes <= 0) continue;
    const pct = (n.usedBytes / n.totalBytes) * 100;
    if (pct > thresholdPct) {
      out.push({
        signal: 'disk-usage',
        resource: `node:${n.name}`,
        severity: pct >= DISK_CRITICAL_PCT ? 'critical' : 'warning',
        message: `Disk on ${n.name} is ${pct.toFixed(1)}% full (threshold ${thresholdPct}%)`,
      });
    }
  }
  return out;
}

/**
 * crash-loop: services whose agent-reported task history shows at least
 * `threshold` failed/rejected tasks in the recent window (agent side: 10 min).
 * Services the agent doesn't report task health for (older agents) never fire.
 */
export function crashLoopConditions(
  services: Array<{ name: string; recentFailures: number | null; lastError?: string }>,
  threshold: number,
): Condition[] {
  const min = Math.max(1, threshold);
  return services
    .filter((s) => s.recentFailures !== null && s.recentFailures >= min)
    .map((s) => ({
      signal: 'crash-loop' as const,
      resource: `service:${s.name}`,
      severity: 'critical' as const,
      message: `Service ${s.name} is crash-looping: ${s.recentFailures} failed tasks in the last 10 min${
        s.lastError ? ` — last error: ${s.lastError.slice(0, 200)}` : ''
      }`,
    }));
}

const BACKUP_UNIT_MS: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/**
 * A backup schedule's next slot, derived (mirror of `@swarmy/trpc`
 * `nextIntervalRun`): the first `anchor + k·interval` strictly after the last
 * run, or after creation when it never ran. Null for a bad interval.
 */
export function derivedNextBackupRun(
  s: { every: number; unit: string; createdAt: Date; anchorAt: Date | null },
  lastRunAt: Date | null,
): Date | null {
  const step = s.every * (BACKUP_UNIT_MS[s.unit] ?? 0);
  if (!(step > 0)) return null;
  const anchor = (s.anchorAt ?? s.createdAt).getTime();
  const from = (lastRunAt ?? s.createdAt).getTime();
  if (from < anchor) return new Date(anchor);
  return new Date(anchor + (Math.floor((from - anchor) / step) + 1) * step);
}

/**
 * backup missed: an unpaused, non-opted-out schedule whose derived `nextRunAt` is more
 * than `graceMs` in the past (the scheduler never picked it up — controller
 * down, target unreachable, node gone).
 */
export function backupMissedConditions(
  schedules: Array<{ volume: string; paused: boolean; optedOutAt: Date | null; nextRunAt: Date | null }>,
  now: number,
  graceMs = BACKUP_MISSED_GRACE_MS,
): Condition[] {
  const out: Condition[] = [];
  for (const s of schedules) {
    if (s.paused || s.optedOutAt || !s.nextRunAt) continue;
    const late = now - s.nextRunAt.getTime();
    if (late <= graceMs) continue;
    out.push({
      signal: 'backup-failed',
      resource: `backup:${s.volume}`,
      severity: 'warning',
      message: `Backup of volume ${s.volume} missed its schedule (due ${s.nextRunAt.toISOString()}, ${Math.round(late / 60_000)} min late)`,
    });
  }
  return out;
}

export function queueDepthConditions(
  entries: Array<{ worker: string; queue: string; wait: number }>,
  threshold: number,
): Condition[] {
  return entries
    .filter((e) => e.wait > threshold)
    .map((e) => ({
      signal: 'queue-depth' as const,
      resource: `queue:${e.worker}/${e.queue}`,
      severity: 'warning' as const,
      message: `Queue ${e.queue} has ${e.wait.toLocaleString()} waiting jobs (threshold ${threshold.toLocaleString()})`,
    }));
}

export function errorRateConditions(
  rows: Array<{ service: string; calls: number; errors: number }>,
  thresholdPct: number,
  minCalls = ERROR_RATE_MIN_CALLS,
): Condition[] {
  const out: Condition[] = [];
  for (const r of rows) {
    if (r.calls < minCalls) continue;
    const pct = (r.errors / r.calls) * 100;
    if (pct > thresholdPct) {
      out.push({
        signal: 'error-rate',
        resource: `service:${r.service}`,
        severity: 'warning',
        message: `Error rate on ${r.service} is ${pct.toFixed(1)}% over ${ERROR_RATE_WINDOW_MIN}m (${r.errors}/${r.calls} spans, threshold ${thresholdPct}%)`,
      });
    }
  }
  return out;
}

/** Mirror of health-summary parseLagSeconds: `12s` / `850ms` / bare number. */
export function parseLagSeconds(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  const ms = /^(\d+(?:\.\d+)?)ms$/.exec(v);
  if (ms) return Number(ms[1]) / 1000;
  const sec = /^(\d+(?:\.\d+)?)s$/.exec(v);
  if (sec) return Number(sec[1]);
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n < 600 ? n : n / 1000;
}

export function dbLagConditions(
  lags: Array<{ cluster: string; member: string; lagSeconds: number }>,
  thresholdSeconds: number,
): Condition[] {
  const worst = new Map<string, { member: string; lagSeconds: number }>();
  for (const l of lags) {
    if (l.lagSeconds <= thresholdSeconds) continue;
    const prev = worst.get(l.cluster);
    if (!prev || l.lagSeconds > prev.lagSeconds) {
      worst.set(l.cluster, { member: l.member, lagSeconds: l.lagSeconds });
    }
  }
  return [...worst.entries()].map(([cluster, w]) => ({
    signal: 'db-degraded' as const,
    resource: `db:${cluster}`,
    severity: 'warning' as const,
    message: `Replica ${w.member} of ${cluster} is ${Math.round(w.lagSeconds)}s behind (threshold ${thresholdSeconds}s)`,
  }));
}

/** Leader flips between ticks (only for clusters seen on BOTH ticks). */
export function leaderChanges(
  prev: Map<string, string>,
  curr: Map<string, string>,
): Array<{ cluster: string; from: string; to: string }> {
  const out: Array<{ cluster: string; from: string; to: string }> = [];
  for (const [cluster, to] of curr) {
    const from = prev.get(cluster);
    if (from && from !== to) out.push({ cluster, from, to });
  }
  return out;
}

/** Effective threshold/forSeconds: the org's rule for the signal, else catalog. */
export interface RuleLike {
  signal: string;
  threshold: number | null;
  forSeconds: number;
  isDefault: boolean;
  createdAt: Date;
}

export function ruleSettings(
  rules: RuleLike[],
  signal: AlertSignal,
): { threshold: number; forSeconds: number } {
  const info = ALERT_SIGNAL_INFO[signal];
  const matching = rules
    .filter((r) => r.signal === signal)
    .sort(
      (a, b) =>
        Number(a.isDefault) - Number(b.isDefault) || a.createdAt.getTime() - b.createdAt.getTime(),
    )[0];
  return {
    threshold: matching?.threshold ?? info.defaultThreshold ?? 0,
    forSeconds: matching?.forSeconds ?? info.defaultForSeconds,
  };
}

// ── ClickHouse error-rate probe (mirror of observability.service fetch) ──────

interface ErrorRateRow {
  service: string;
  calls: number;
  errors: number;
}

const chLit = (value: string): string =>
  `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function fetchErrorRates(orgId: string, dsnPlain: string): Promise<ErrorRateRow[] | null> {
  let u: URL;
  try {
    u = new URL(dsnPlain);
  } catch {
    return null;
  }
  const url = new URL(`${u.protocol}//${u.host}`);
  url.searchParams.set('database', u.pathname.replace(/^\//, '') || 'otel');
  url.searchParams.set('default_format', 'JSONEachRow');
  const sql = [
    'SELECT ServiceName AS service, count() AS calls,',
    "  countIf(StatusCode = 'STATUS_CODE_ERROR') AS errors",
    'FROM otel_traces',
    `WHERE ResourceAttributes['swarmy.org_id'] = ${chLit(orgId)}`,
    `  AND Timestamp >= now() - INTERVAL ${ERROR_RATE_WINDOW_MIN} MINUTE`,
    'GROUP BY service',
    'LIMIT 200',
  ].join('\n');
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'X-ClickHouse-User': decodeURIComponent(u.username || 'default'),
        'X-ClickHouse-Key': decodeURIComponent(u.password || ''),
        'Content-Type': 'text/plain',
      },
      body: sql,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim()) return [];
    return text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { service: string; calls: number | string; errors: number | string })
      .map((r) => ({ service: r.service, calls: Number(r.calls), errors: Number(r.errors) }));
  } catch {
    return null;
  }
}

// ── Tick state (per org; reset on restart — DB rows are the durable truth) ───

/** Signals resolved automatically when their condition clears. */
const LEVEL_SIGNALS: AlertSignal[] = [
  'node-offline',
  'service-down',
  'crash-loop',
  'db-degraded',
  'backup-failed',
  'disk-usage',
  'queue-depth',
  'error-rate',
  'store-unreachable',
];

const pendingByOrg = new Map<string, Map<string, number>>();
const firedByOrg = new Map<string, Set<string>>();
const leadersByOrg = new Map<string, Map<string, string>>();

const orgMap = <T>(bag: Map<string, T>, orgId: string, make: () => T): T => {
  let v = bag.get(orgId);
  if (!v) {
    v = make();
    bag.set(orgId, v);
  }
  return v;
};

// ── Condition collection ──────────────────────────────────────────────────────

async function collectConditions(ctx: OrgContext, rules: RuleLike[]): Promise<Condition[]> {
  const orgId = ctx.activeOrgId;
  const conditions: Condition[] = [];

  // node-offline + disk-usage — enrolled nodes vs hub state.
  const nodes = await prisma.node.findMany({
    where: { orgId },
    select: { id: true, name: true },
  });
  for (const n of nodes) {
    if (hub.lastSeen(n.id) !== undefined && !hub.isOnline(n.id)) {
      conditions.push({
        signal: 'node-offline',
        resource: `node:${n.name}`,
        severity: 'critical',
        message: `Node ${n.name} is offline`,
      });
    }
  }
  const diskThreshold = ruleSettings(rules, 'disk-usage').threshold;
  conditions.push(
    ...diskConditions(
      nodes.map((n) => {
        const s = hub.latestNodeStats(n.id);
        return { name: n.name, usedBytes: s?.fsUsedBytes ?? null, totalBytes: s?.fsTotalBytes ?? null };
      }),
      diskThreshold,
    ),
  );
  // disk-usage forecast — "full in N days" + a concrete next step (same rule).
  {
    const now = Date.now();
    const swarmNodes = hub.nodeInventory(orgId, true);
    const forecastNodes = await Promise.all(
      nodes.map(async (n) => {
        const s = hub.latestNodeStats(n.id);
        const swarmNodeId = hub.swarmNodeIdFor(n.id);
        const sw = swarmNodes.find((x) => x.swarmNodeId === swarmNodeId);
        return {
          name: n.name,
          swarmNodeId,
          series: await loadDiskSeries(orgId, n.id, now),
          live: s?.fsUsedBytes != null && s.fsTotalBytes ? { usedBytes: s.fsUsedBytes, totalBytes: s.fsTotalBytes } : null,
          schedulable: hub.isOnline(n.id) && sw?.availability === 'active' && sw.status === 'ready',
        };
      }),
    );
    conditions.push(...forecastConditions(forecastNodes, hub.liveInventory(orgId).services, now));
  }

  // service-down + db lag + queue depth — one pass over the live inventory.
  const { services } = hub.liveInventory(orgId);
  conditions.push(
    ...serviceDownConditions(
      services.map((s) => ({
        name: s.name,
        desired: s.desiredReplicas ?? 0,
        running: s.runningReplicas ?? 0,
      })),
    ),
  );

  const crashThreshold = ruleSettings(rules, 'crash-loop').threshold;
  conditions.push(
    ...crashLoopConditions(
      services.map((s) => ({
        name: s.name,
        recentFailures: s.taskHealth?.recentFailures ?? null,
        lastError: s.taskHealth?.lastError,
      })),
      crashThreshold,
    ),
  );

  const lagThreshold = ruleSettings(rules, 'db-degraded').threshold;
  const lags: Array<{ cluster: string; member: string; lagSeconds: number }> = [];
  for (const s of services) {
    const cluster = s.labels[DB_CLUSTER_LABEL];
    if (!cluster) continue;
    const stack = s.labels[STACK_LABEL] ?? '';
    for (const [key, value] of Object.entries(s.labels)) {
      if (!key.startsWith(DB_LAG_PREFIX)) continue;
      const lagSeconds = parseLagSeconds(value);
      if (lagSeconds === null) continue;
      lags.push({
        cluster: stack ? `${stack}/${cluster}` : cluster,
        member: key.slice(DB_LAG_PREFIX.length),
        lagSeconds,
      });
    }
  }
  conditions.push(...dbLagConditions(lags, lagThreshold));

  const queueThreshold = ruleSettings(rules, 'queue-depth').threshold;
  const queueEntries: Array<{ worker: string; queue: string; wait: number }> = [];
  for (const s of services) {
    const raw = s.labels[QUEUES_STATS_LABEL];
    if (!raw) continue;
    try {
      const stats = JSON.parse(raw) as Record<string, { wait?: unknown }>;
      if (stats === null || typeof stats !== 'object' || Array.isArray(stats)) continue;
      for (const [queue, sample] of Object.entries(stats)) {
        if (typeof sample?.wait === 'number') {
          queueEntries.push({ worker: s.name, queue, wait: sample.wait });
        }
      }
    } catch {
      // malformed stats label — skip
    }
  }
  conditions.push(...queueDepthConditions(queueEntries, queueThreshold));

  // backup-failed — a schedule whose most recent finished job failed.
  const scheduleRows = await prisma.backupSchedule.findMany({
    where: { orgId },
    select: {
      id: true,
      volume: true,
      paused: true,
      optedOutAt: true,
      every: true,
      unit: true,
      createdAt: true,
      anchorAt: true,
    },
  });
  // No stored nextRunAt: derive it from the newest BackupJob (run history).
  const lastRuns = scheduleRows.length
    ? await prisma.backupJob.groupBy({
        by: ['scheduleId'],
        where: { orgId, scheduleId: { in: scheduleRows.map((s) => s.id) } },
        _max: { startedAt: true },
      })
    : [];
  const lastRunOf = new Map(lastRuns.map((r) => [r.scheduleId, r._max.startedAt]));
  const schedules = scheduleRows.map((s) => ({
    ...s,
    nextRunAt: derivedNextBackupRun(s, lastRunOf.get(s.id) ?? null),
  }));
  const failedVolumes = new Set<string>();
  for (const schedule of schedules) {
    if (schedule.optedOutAt) continue;
    const last = await prisma.backupJob.findFirst({
      where: { orgId, scheduleId: schedule.id, status: { not: 'RUNNING' } },
      orderBy: { startedAt: 'desc' },
      select: { status: true, error: true },
    });
    if (last?.status === 'FAILED') {
      failedVolumes.add(schedule.volume);
      conditions.push({
        signal: 'backup-failed',
        resource: `backup:${schedule.volume}`,
        severity: 'warning',
        message: `Last backup of volume ${schedule.volume} failed${last.error ? `: ${last.error.slice(0, 200)}` : ''}`,
      });
    }
  }

  // A missed slot on a volume that already has a failed-run condition is the
  // same alert (same resource) — the failure message is the more useful one.
  conditions.push(
    ...backupMissedConditions(schedules, Date.now()).filter(
      (c) => !failedVolumes.has(c.resource.slice('backup:'.length)),
    ),
  );

  // store-unreachable + error-rate — observability store state / ClickHouse RED.
  const obsConfig = await observabilityConfigRepo.find({ db: prisma, hub }, orgId).catch(() => null);
  if (obsConfig?.enabled) {
    // The reconcile worker's latest live probe (in memory; null before its first tick).
    const state = latestStoreProbe(orgId);
    if (state && !state.reachable) {
      conditions.push({
        signal: 'store-unreachable',
        resource: 'observability:store',
        severity: 'warning',
        message: 'The observability store (ClickHouse) is not answering the controller',
      });
    } else if (obsConfig.clickhouseDsn) {
      let dsnPlain: string;
      try {
        dsnPlain = decryptSecret(obsConfig.clickhouseDsn);
      } catch {
        dsnPlain = obsConfig.clickhouseDsn;
      }
      const rows = await fetchErrorRates(orgId, dsnPlain);
      if (rows) {
        const { threshold } = ruleSettings(rules, 'error-rate');
        conditions.push(...errorRateConditions(rows, threshold));
      }
    }
  }

  return conditions;
}

// ── Per-org tick ──────────────────────────────────────────────────────────────

async function evaluateOrg(orgId: string): Promise<void> {
  const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
  // Default alerts are ON for every org — seed any missing default (idempotent,
  // steady state = one read; tombstoned opt-outs are never re-created).
  await ensureDefaultRules(ctx).catch(() => undefined);
  const rules = (await prisma.alertRule.findMany({
    where: { orgId },
    select: { signal: true, threshold: true, forSeconds: true, isDefault: true, createdAt: true },
  })) as RuleLike[];

  const conditions = await collectConditions(ctx, rules);

  // db-failover — edge on `swarmy.db.leader` flips vs the previous tick.
  const { services } = hub.liveInventory(orgId);
  const currLeaders = new Map<string, string>();
  for (const s of services) {
    const cluster = s.labels[DB_CLUSTER_LABEL];
    const leader = s.labels[DB_LEADER_LABEL];
    if (!cluster || !leader) continue;
    const stack = s.labels[STACK_LABEL] ?? '';
    currLeaders.set(stack ? `${stack}/${cluster}` : cluster, leader);
  }
  const prevLeaders = orgMap(leadersByOrg, orgId, () => new Map<string, string>());
  for (const change of leaderChanges(prevLeaders, currLeaders)) {
    const message = `Database cluster ${change.cluster} failed over: leader ${change.from} → ${change.to}`;
    await fireEvent(ctx, {
      signal: 'db-failover',
      severity: 'critical',
      resource: `db:${change.cluster}`,
      message,
    }).catch(() => undefined);
    await recordIncidentEvent(ctx, {
      groupKey: `db:${change.cluster}`,
      kind: 'db.failover',
      message,
      severity: 'critical',
      meta: { from: change.from, to: change.to },
    }).catch(() => undefined);
  }
  leadersByOrg.set(orgId, currLeaders);

  // Gate on for-duration, then fire.
  const pending = orgMap(pendingByOrg, orgId, () => new Map<string, number>());
  const fired = orgMap(firedByOrg, orgId, () => new Set<string>());
  const ready = gateConditions(
    pending,
    conditions,
    (signal) => ruleSettings(rules, signal).forSeconds,
    Date.now(),
  );
  for (const c of ready) {
    await fireEvent(ctx, c).catch(() => undefined);
    const key = conditionKey(c);
    if (!fired.has(key)) {
      fired.add(key);
      if (c.severity === 'critical') {
        await recordIncidentEvent(ctx, {
          groupKey: `alert:${c.resource}`,
          kind: 'alert.fired',
          message: c.message,
          severity: 'critical',
          meta: { signal: c.signal },
        }).catch(() => undefined);
      }
    }
  }

  // Resolve level-triggered events whose condition cleared.
  const active = new Set(conditions.map(conditionKey));
  const open = await prisma.alertEvent.findMany({
    where: { orgId, status: 'FIRING', signal: { in: LEVEL_SIGNALS } },
    select: { signal: true, resource: true, severity: true, message: true },
  });
  for (const event of open) {
    const key = `${event.signal}|${event.resource}`;
    if (active.has(key)) continue;
    await fireEvent(ctx, {
      signal: event.signal,
      severity: 'info',
      resource: event.resource,
      message: `${event.signal} on ${event.resource} recovered`,
      status: 'resolved',
    }).catch(() => undefined);
    if (fired.delete(key) && event.severity === 'critical') {
      await recordIncidentEvent(ctx, {
        groupKey: `alert:${event.resource}`,
        kind: 'alert.resolved',
        message: `${event.signal} on ${event.resource} recovered`,
        meta: { signal: event.signal },
      }).catch(() => undefined);
    }
  }

  // ORCHESTRATOR TODO: once `sampleUptimeTick` (statusPages.service, slice C5)
  // is exported from the `@swarmy/trpc` package root, sample status-page
  // uptime here: `await sampleUptimeTick(ctx)`.
}

export function startAlertEvaluator(): () => void {
  const timer = setInterval(() => {
    const orgIds = new Set(store.nodeOrg.values());
    for (const orgId of orgIds) void evaluateOrg(orgId).catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
