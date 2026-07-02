import {
  buildInventory,
  UNGROUPED,
  type HealthEntryView,
  type HealthNarrativeView,
  type InvService,
  type ObservabilityHealthInput,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { redSnapshot, type RedSnapshot } from './observability.service';
import {
  MAP_ERROR_RATE_DEGRADED,
  MAP_P95_DEGRADED_MS,
  type ServiceMapNodeRow,
} from './observability-map';
import { parseQueueStatsLabel, QUEUES_STATS_LABEL } from './queues.service';

/**
 * Health narrative (slice C2) — composes a per-stack / per-service
 * `{ status, reasons[] }` summary from live inventory, service status, RED
 * metrics, `swarmy.db.lag.*` labels, queue stats, and collector/store state.
 * Consumed by stacks, status pages, alerts, and deploy safety.
 *
 * Signals (in the order their reasons are emitted):
 *  (a) live inventory task state — desired vs running per service;
 *  (f) offline nodes (enrolled, seen before, not connected now);
 *  (c) `swarmy.db.lag.<member>` labels stamped by the managed-db reconcile;
 *  (d) the `swarmy.queues.stats` label stamped by queue-reconcile
 *      (failed jobs / a wait depth that grew since the last look);
 *  (b) RED metrics (p95 latency + error rate over entry spans) when the
 *      ClickHouse store is reachable;
 *  (e) collector/store state — an INFO reason only (telemetry being blind
 *      never fails a health gate on its own).
 *
 * `composeHealth` is pure (unit-tested with fixture inputs); the exported
 * summarize* functions gather live signals and delegate to it.
 */

export interface HealthSummary {
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  reasons: string[];
}

// ── Targets / labels ──────────────────────────────────────────────────────────

/** p95 latency target (ms) — shared with the service map tinting. */
export const P95_TARGET_MS = MAP_P95_DEGRADED_MS;
/** Error-rate target (0..1) — shared with the service map tinting. */
export const ERROR_RATE_TARGET = MAP_ERROR_RATE_DEGRADED;
/** Replica lag above this many seconds is a degraded reason. */
export const DB_LAG_TARGET_SECONDS = 10;
/** A rising queue only counts once its wait depth reaches this. */
export const QUEUE_RISING_MIN_WAIT = 10;

/** `swarmy.db.lag.<member>` — per-replica lag stamped by manageddb-reconcile. */
export const DB_LAG_LABEL_PREFIX = 'swarmy.db.lag.';

// ── Pure signal shapes (fixture-friendly) ─────────────────────────────────────

export interface TaskSignal {
  name: string;
  desired: number;
  running: number;
  scaleToZero: boolean;
}

export interface DbLagSignal {
  member: string;
  lagSeconds: number;
}

export interface QueueSignal {
  queue: string;
  wait: number;
  failed: number;
  /** Wait depth at the previous observation (for "rising" detection). */
  prevWait?: number;
}

export interface RedSignal {
  service: string;
  p95Ms: number;
  /** 0..1. */
  errorRate: number;
}

export interface CollectorSignal {
  enabled: boolean;
  /** Collector deploy recorded as FAILED. */
  failed: boolean;
  storeReachable: boolean;
}

export interface HealthSignals {
  services: TaskSignal[];
  dbLags?: DbLagSignal[];
  queues?: QueueSignal[];
  red?: RedSignal[];
  offlineNodes?: string[];
  collector?: CollectorSignal;
}

// ── Pure parsers ──────────────────────────────────────────────────────────────

/**
 * Parse one `swarmy.db.lag.*` label value into seconds. Accepts an explicit
 * unit (`12s`, `850ms`) or a bare number — bare values < 600 read as seconds,
 * larger ones as milliseconds (a replica is never legitimately 10+ minutes
 * behind, but a ms-stamping reconcile easily produces 12000).
 */
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

/** Extract every `swarmy.db.lag.<member>` label from a label map. */
export function dbLagsFromLabels(labels: Record<string, string>): DbLagSignal[] {
  const out: DbLagSignal[] = [];
  for (const [key, value] of Object.entries(labels)) {
    if (!key.startsWith(DB_LAG_LABEL_PREFIX)) continue;
    const member = key.slice(DB_LAG_LABEL_PREFIX.length);
    const lagSeconds = parseLagSeconds(value);
    if (member && lagSeconds !== null) out.push({ member, lagSeconds });
  }
  return out;
}

/**
 * Match RED rows (keyed by OTel service name) to the services in scope. The
 * OTel name is the Docker service name or its bare in-stack name (`web` for
 * `shop_web`) depending on how the spec was deployed — accept both.
 */
export function matchRedToServices(
  rows: Pick<ServiceMapNodeRow, 'service_name' | 'error_rate' | 'p95_ms'>[],
  services: Pick<InvService, 'name' | 'stack'>[],
): RedSignal[] {
  const names = new Set<string>();
  for (const s of services) {
    names.add(s.name);
    if (s.stack !== UNGROUPED && s.name.startsWith(`${s.stack}_`)) {
      names.add(s.name.slice(s.stack.length + 1));
    }
  }
  return rows
    .filter((r) => names.has(r.service_name))
    .map((r) => ({ service: r.service_name, p95Ms: r.p95_ms, errorRate: r.error_rate }));
}

// ── Pure composition ──────────────────────────────────────────────────────────

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtLag(seconds: number): string {
  return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}

/**
 * Fold raw signals into `{ status, reasons[] }` — reasons ordered worst-first:
 * down services, task shortfalls, offline nodes, replica lag, queue trouble,
 * error rate, latency, then info-only telemetry notes. Info reasons never
 * change the status (a blind store must not fail a deploy health gate).
 */
export function composeHealth(sig: HealthSignals): HealthSummary {
  const down: string[] = [];
  const degraded: string[] = [];
  const info: string[] = [];
  const multi = sig.services.length !== 1;

  for (const s of sig.services) {
    if (s.desired <= 0) continue; // idle / intentionally stopped
    if (s.running === 0) {
      if (s.scaleToZero) degraded.push(`service ${s.name} still waking (0/${s.desired} tasks running)`);
      else down.push(`service ${s.name} is down (0/${s.desired} tasks running)`);
    } else if (s.running < s.desired) {
      degraded.push(`service ${s.name} running ${s.running}/${s.desired} tasks`);
    }
  }

  for (const n of sig.offlineNodes ?? []) degraded.push(`node ${n} offline`);

  for (const lag of sig.dbLags ?? []) {
    if (lag.lagSeconds > DB_LAG_TARGET_SECONDS) {
      degraded.push(
        `database replica lag ${fmtLag(lag.lagSeconds)} (member ${lag.member}, target <${DB_LAG_TARGET_SECONDS}s)`,
      );
    }
  }

  for (const q of sig.queues ?? []) {
    if (q.failed > 0) degraded.push(`queue ${q.queue} has ${q.failed} failed job${q.failed === 1 ? '' : 's'}`);
  }
  for (const q of sig.queues ?? []) {
    if (q.prevWait !== undefined && q.wait > q.prevWait && q.wait >= QUEUE_RISING_MIN_WAIT) {
      degraded.push(`queue depth rising (${q.queue}: ${q.wait} waiting)`);
    }
  }

  for (const r of sig.red ?? []) {
    if (r.errorRate > ERROR_RATE_TARGET) {
      degraded.push(
        `${multi ? `${r.service}: ` : ''}error rate ${fmtPct(r.errorRate)} (target <${fmtPct(ERROR_RATE_TARGET)})`,
      );
    }
  }
  for (const r of sig.red ?? []) {
    if (r.p95Ms > P95_TARGET_MS) {
      degraded.push(
        `${multi ? `${r.service}: ` : ''}p95 latency ${fmtSec(r.p95Ms)} (target <${fmtSec(P95_TARGET_MS)})`,
      );
    }
  }

  if (sig.collector?.enabled) {
    if (sig.collector.failed) info.push('telemetry collector failed to deploy — latency and error-rate checks are blind');
    else if (!sig.collector.storeReachable) info.push('telemetry store unreachable — latency and error-rate checks are blind');
  }

  const active = sig.services.filter((s) => s.desired > 0 && !s.scaleToZero);
  let status: HealthSummary['status'];
  if (active.length > 0 && active.every((s) => s.running === 0)) status = 'down';
  else if (down.length > 0 || degraded.length > 0) status = 'degraded';
  else if (sig.services.length === 0) status = 'unknown';
  else status = 'healthy';

  return { status, reasons: [...down, ...degraded, ...info] };
}

// ── Live signal gathering ─────────────────────────────────────────────────────

function liveServices(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

/** Enrolled nodes that have been seen before but are not connected now. */
async function offlineNodeNames(ctx: OrgContext): Promise<string[]> {
  const rows = (await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true, name: true },
  })) as Array<{ id: string; name: string }>;
  return rows
    .filter((n) => !ctx.hub.isOnline(n.id) && ctx.hub.lastSeen(n.id) != null)
    .map((n) => n.name);
}

async function safeRed(ctx: OrgContext): Promise<RedSnapshot | null> {
  try {
    return await redSnapshot(ctx);
  } catch {
    return null;
  }
}

/** Last observed queue wait depth, per org|service|queue — "rising" detection. */
const lastQueueWait = new Map<string, number>();

/**
 * Read every `swarmy.queues.stats` label in scope ONCE per summary call
 * (updating the rising-detection cache exactly once), keyed by service name.
 */
function sampleQueueSignals(orgId: string, services: InvService[]): Map<string, QueueSignal[]> {
  const out = new Map<string, QueueSignal[]>();
  for (const svc of services) {
    const stats = parseQueueStatsLabel(svc.labels[QUEUES_STATS_LABEL]);
    const signals: QueueSignal[] = [];
    for (const [queue, sample] of Object.entries(stats)) {
      const key = `${orgId}|${svc.name}|${queue}`;
      const prevWait = lastQueueWait.get(key);
      lastQueueWait.set(key, sample.wait);
      signals.push({
        queue,
        wait: sample.wait,
        failed: sample.failed,
        ...(prevWait !== undefined ? { prevWait } : {}),
      });
    }
    if (signals.length > 0) out.set(svc.name, signals);
  }
  return out;
}

interface ScopeSignalArgs {
  services: InvService[];
  queuesByService: Map<string, QueueSignal[]>;
  red: RedSnapshot | null;
  offlineNodes: string[];
  /** Org scope always lists offline nodes; narrower scopes only when the scope
   *  isn't fully running (an offline node is then the likely cause). */
  alwaysIncludeOffline: boolean;
  includeCollector: boolean;
}

function buildSignals(args: ScopeSignalArgs): HealthSignals {
  const { services } = args;
  const shortfall = services.some((s) => s.replicas.desired > 0 && s.replicas.running < s.replicas.desired);
  return {
    services: services.map((s) => ({
      name: s.name,
      desired: s.replicas.desired,
      running: s.replicas.running,
      scaleToZero: s.scaleToZero,
    })),
    dbLags: services.flatMap((s) => dbLagsFromLabels(s.labels)),
    queues: services.flatMap((s) => args.queuesByService.get(s.name) ?? []),
    red: args.red?.reachable ? matchRedToServices(args.red.rows, services) : [],
    offlineNodes: args.alwaysIncludeOffline || shortfall ? args.offlineNodes : [],
    ...(args.includeCollector && args.red
      ? {
          collector: {
            enabled: args.red.enabled,
            failed: args.red.collectorStatus === 'FAILED',
            storeReachable: args.red.reachable,
          },
        }
      : {}),
  };
}

// ── Public API (spine contract — signatures unchanged) ───────────────────────

/** Summarize the health of one stack (by stack namespace name). */
export async function summarizeStack(ctx: OrgContext, stackName: string): Promise<HealthSummary> {
  const services = liveServices(ctx).filter((s) => s.stack === stackName);
  const [red, offline] = await Promise.all([safeRed(ctx), offlineNodeNames(ctx)]);
  return composeHealth(
    buildSignals({
      services,
      queuesByService: sampleQueueSignals(ctx.activeOrgId, services),
      red,
      offlineNodes: offline,
      alwaysIncludeOffline: false,
      includeCollector: true,
    }),
  );
}

/** Summarize the health of one service (by id or name). */
export async function summarizeService(
  ctx: OrgContext,
  serviceRef: string,
): Promise<HealthSummary> {
  const svc = liveServices(ctx).find((s) => s.id === serviceRef || s.name === serviceRef);
  if (!svc) return { status: 'unknown', reasons: [] };
  const [red, offline] = await Promise.all([safeRed(ctx), offlineNodeNames(ctx)]);
  return composeHealth(
    buildSignals({
      services: [svc],
      queuesByService: sampleQueueSignals(ctx.activeOrgId, [svc]),
      red,
      offlineNodes: offline,
      alwaysIncludeOffline: false,
      includeCollector: false,
    }),
  );
}

/**
 * The estate-wide narrative behind `observability.health`: one top-level
 * `{ status, reasons[] }` over every service in scope plus a per-stack
 * breakdown. Pure read — no audit row.
 */
export async function healthNarrative(
  ctx: OrgContext,
  input: ObservabilityHealthInput,
): Promise<HealthNarrativeView> {
  const all = liveServices(ctx);
  const inScope = input.stack ? all.filter((s) => s.stack === input.stack) : all;
  const [red, offline] = await Promise.all([safeRed(ctx), offlineNodeNames(ctx)]);
  // Sample queue labels ONCE so the rising-detection cache advances one step
  // per narrative, not once per stack entry.
  const queuesByService = sampleQueueSignals(ctx.activeOrgId, inScope);

  const stackNames = input.stack
    ? [input.stack]
    : [...new Set(inScope.map((s) => s.stack))];

  const entries: HealthEntryView[] = stackNames.map((name) => {
    const services = inScope.filter((s) => s.stack === name);
    const summary = composeHealth(
      buildSignals({
        services,
        queuesByService,
        red,
        offlineNodes: offline,
        alwaysIncludeOffline: false,
        includeCollector: false,
      }),
    );
    return { kind: 'stack', name, status: summary.status, reasons: summary.reasons };
  });

  const top = composeHealth(
    buildSignals({
      services: inScope,
      queuesByService,
      red,
      offlineNodes: offline,
      alwaysIncludeOffline: true,
      includeCollector: true,
    }),
  );

  return {
    status: top.status,
    reasons: top.reasons,
    entries,
    generatedAt: new Date().toISOString(),
  };
}
