/**
 * Queue studio — browse and operate BullMQ queues on a managed cache.
 *
 * Every op is a typed `queue.op` agent command (see `@swarmy/core`
 * `bullmq/ops.ts`) run as ONE EVAL inside the cache PRIMARY's container on
 * the node hosting it. Managed caches are private-only, so nothing here opens
 * a network path, and the password never leaves the member's secret file.
 * Reads are bounded (paged, payloads cut to a byte budget). Writes use
 * BullMQ's own scripts, and each is ABAC-gated at the router (`data.write`;
 * remove/clean/drain need `data.destroy`) and audited here.
 *
 * Discovery is by key pattern (`<prefix>:*:meta`), so the studio shows every
 * BullMQ queue on the cluster, not only those attached to a worker
 * definition. The rate sampler (`sampleQueueClusters`, run by the
 * queue-reconcile worker) keeps a per-queue events-stream cursor in memory.
 * It turns completed/failed events into throughput/failure rates and writes
 * one row per queue per tick into the observability store
 * (`swarmy_queue_samples`).
 */
import {
  QueueJobReply,
  QueueJobsReply,
  QueueMutationReply,
  QueueOp,
  QueueOverviewReply,
  queueBacklog,
  type BullQueueSample,
  type QueueOpInput,
} from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import {
  CACHE_CLUSTER_LABEL,
  CACHE_ENGINE_LABEL,
  CACHE_ROLE_LABEL,
  cachePrimaryName,
  cachePurposeOf,
  listCacheClusters,
  type CachePurpose,
} from './cache.service';
import { resolveExecTarget, resolveLiveService } from './live-resolve';
import { orgClickhouse, type OrgClickhouse } from './observability.service';
import {
  QUEUE_SAMPLES_TABLE,
  buildQueueRatesQuery,
  chTime,
  ratePoint,
  renderQueueSamplesSchema,
  type QueueRateBucket,
  type QueueSampleRow,
  type RateCursor,
  type RatePoint,
  type StudioClusterInput,
  type StudioJobInput,
  type StudioJobsInput,
  type StudioQueueInput,
  type StudioRatesInput,
} from './queue-studio.core';

/** Wire deadline for one op (agent enforces DEFAULT_COMMAND_TIMEOUTS.queueOp = 30s). */
const DISPATCH_TIMEOUT_MS = 35_000;
/** Batched writes (retryAll/promoteAll/clean) stop after this many rounds. */
const MAX_BATCHES = 20;

// ── Target resolution ────────────────────────────────────────────────────────

interface StudioTarget {
  nodeId: string;
  containerId: string;
  engine: 'valkey' | 'redis';
  primary: string;
  purpose: CachePurpose;
}

/** The cluster's primary container, from the live inventory. Managed caches only. */
export function resolveStudioTarget(ctx: OrgContext, ref: { stack: string; cluster: string }): StudioTarget {
  const name = cachePrimaryName(ref.stack, ref.cluster);
  const svc = resolveLiveService(ctx, name);
  if (!svc || svc.labels[CACHE_CLUSTER_LABEL] !== ref.cluster || svc.labels[CACHE_ROLE_LABEL] !== 'primary') {
    throw notFound('cache cluster', `${ref.stack}/${ref.cluster}`);
  }
  const exec = resolveExecTarget(ctx, svc.name);
  if (!exec) throw commandRejected(`cache primary ${svc.name} has no running container`);
  return {
    nodeId: exec.nodeId,
    containerId: exec.containerId,
    engine: svc.labels[CACHE_ENGINE_LABEL] === 'redis' ? 'redis' : 'valkey',
    primary: svc.name,
    purpose: cachePurposeOf(svc.labels),
  };
}

async function runOp(ctx: OrgContext, target: StudioTarget, input: QueueOpInput): Promise<unknown> {
  const op = QueueOp.parse(input);
  try {
    return await ctx.hub.dispatch(
      target.nodeId,
      'queue.op',
      { target: { containerId: target.containerId }, engine: target.engine, op },
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
}

function auditTarget(i: StudioQueueInput): string {
  return `${i.stack}/${i.cluster}/${i.queue}`;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface StudioClusterView {
  stack: string;
  cluster: string;
  engine: string;
  purpose: CachePurpose;
  online: boolean;
  host: string;
}

/** Managed cache clusters the studio can open (queue-purpose first). */
export function studioClusters(ctx: OrgContext, stack?: string): StudioClusterView[] {
  return listCacheClusters(ctx, stack)
    .map((c) => ({
      stack: c.stack,
      cluster: c.name,
      engine: c.engine,
      purpose: c.purpose,
      online: c.primary.status !== 'absent' && c.members.some((m) => m.role === 'primary' && m.running > 0),
      host: c.host,
    }))
    .sort((a, b) => (a.purpose === b.purpose ? 0 : a.purpose === 'queue' ? -1 : 1));
}

export interface StudioQueueView extends BullQueueSample {
  /** What the autoscaler reads: wait + prioritized (0 while paused). */
  backlog: number;
  /** Last sampler rate point (null until two ticks have run). */
  rate: RatePoint | null;
}

export interface StudioOverviewView {
  stack: string;
  cluster: string;
  prefix: string;
  purpose: CachePurpose;
  primary: string;
  queues: StudioQueueView[];
  truncated: boolean;
  sampledAt: string;
}

export async function studioOverview(ctx: OrgContext, input: StudioClusterInput): Promise<StudioOverviewView> {
  const target = resolveStudioTarget(ctx, input);
  const reply = QueueOverviewReply.parse(await runOp(ctx, target, { kind: 'overview', prefix: input.prefix }));
  return {
    stack: input.stack,
    cluster: input.cluster,
    prefix: input.prefix,
    purpose: target.purpose,
    primary: target.primary,
    truncated: reply.truncated,
    sampledAt: new Date().toISOString(),
    queues: reply.queues.map((q) => ({
      ...q,
      backlog: queueBacklog(q),
      rate: latestRates.get(rateKey(ctx.activeOrgId, input, q.name)) ?? null,
    })),
  };
}

export async function studioJobs(ctx: OrgContext, input: StudioJobsInput): Promise<QueueJobsReply> {
  const target = resolveStudioTarget(ctx, input);
  return QueueJobsReply.parse(
    await runOp(ctx, target, {
      kind: 'jobs',
      prefix: input.prefix,
      queue: input.queue,
      state: input.state,
      start: input.start,
      count: input.count,
    }),
  );
}

export async function studioJob(ctx: OrgContext, input: StudioJobInput): Promise<QueueJobReply> {
  const target = resolveStudioTarget(ctx, input);
  return QueueJobReply.parse(
    await runOp(ctx, target, { kind: 'job', prefix: input.prefix, queue: input.queue, id: input.id }),
  );
}

// ── Writes (router gates: data.write / data.destroy) ─────────────────────────

export type StudioAction =
  | { kind: 'retry'; id: string; from: 'failed' | 'completed' }
  | { kind: 'retryAll'; from: 'failed' | 'completed' }
  | { kind: 'promote'; id: string }
  | { kind: 'promoteAll' }
  | { kind: 'remove'; id: string }
  | { kind: 'clean'; state: 'wait' | 'paused' | 'prioritized' | 'delayed' | 'completed' | 'failed'; graceMs: number; limit: number }
  | { kind: 'pause'; paused: boolean }
  | { kind: 'drain'; delayed: boolean };

export interface StudioActionResult {
  ok: boolean;
  message: string;
  /** Batched ops: rounds run; clean: ids removed. */
  batches?: number;
  removed?: number;
}

/** Run one studio write, batching where BullMQ does, and audit it (ok or refused). */
export async function studioAction(
  ctx: OrgContext,
  input: StudioQueueInput,
  action: StudioAction,
): Promise<StudioActionResult> {
  const target = resolveStudioTarget(ctx, input);
  const base = { prefix: input.prefix, queue: input.queue };
  const once = async (op: QueueOpInput) => QueueMutationReply.parse(await runOp(ctx, target, op));
  let result: StudioActionResult;

  switch (action.kind) {
    case 'retryAll':
    case 'promoteAll': {
      // BullMQ's moveJobsToWait moves up to `count` per call and says whether more remain.
      const timestamp = Date.now();
      let batches = 0;
      let r: QueueMutationReply;
      do {
        r = await once(
          action.kind === 'retryAll'
            ? { kind: 'retryAll', ...base, from: action.from, timestamp }
            : { kind: 'promoteAll', ...base },
        );
        batches++;
      } while (r.more && batches < MAX_BATCHES);
      result = {
        ok: true,
        batches,
        message: r.more
          ? `moved ${batches} batches; more remain — run it again`
          : action.kind === 'retryAll'
            ? `every ${action.from} job is back on the queue`
            : 'every delayed job is waiting now',
      };
      break;
    }
    case 'clean': {
      const timestamp = Date.now() - action.graceMs;
      let removed = 0;
      let batches = 0;
      const per = Math.min(action.limit, 1000);
      while (removed < action.limit && batches < MAX_BATCHES) {
        const r = await once({
          kind: 'clean',
          ...base,
          state: action.state,
          timestamp,
          limit: Math.min(per, action.limit - removed),
        });
        batches++;
        removed += r.removedIds?.length ?? 0;
        if ((r.removedIds?.length ?? 0) < per) break;
      }
      result = { ok: true, removed, batches, message: `removed ${removed} ${action.state} job${removed === 1 ? '' : 's'}` };
      break;
    }
    default: {
      const r = await once({ ...action, ...base } as QueueOpInput);
      result = { ok: r.ok, message: r.message };
    }
  }

  await writeAudit(ctx, {
    action: `queues.studio.${action.kind}`,
    targetType: 'queue',
    targetId: auditTarget(input),
    metadata: { ...action, prefix: input.prefix, ok: result.ok, message: result.message },
  });
  if (!result.ok) throw commandRejected(result.message);
  return result;
}

// ── Rates: sampler + read ────────────────────────────────────────────────────

const cursors = new Map<string, RateCursor>();
const latestRates = new Map<string, RatePoint>();
const ensuredSchema = new Map<string, string>();

function rateKey(orgId: string, c: { stack: string; cluster: string; prefix: string }, queue: string): string {
  return `${orgId}|${c.stack}|${c.cluster}|${c.prefix}|${queue}`;
}

async function samplesStore(ctx: OrgContext): Promise<OrgClickhouse | null> {
  const ch = await orgClickhouse(ctx).catch(() => null);
  if (!ch) return null;
  const sig = `${ch.database}|${ch.retentionDays}`;
  if (ensuredSchema.get(ctx.activeOrgId) !== sig) {
    for (const stmt of renderQueueSamplesSchema({ database: ch.database, retentionDays: ch.retentionDays })) {
      await ch.exec(stmt);
    }
    ensuredSchema.set(ctx.activeOrgId, sig);
  }
  return ch;
}

export interface SampledCluster {
  stack: string;
  cluster: string;
  queues: BullQueueSample[];
}

/**
 * One sampler tick for the org. For every queue-purpose cluster, plus any
 * `extra` clusters the caller names (worker queue defs on plain caches, with
 * their queue names), it runs one overview op with the per-queue events
 * cursors, updates the rate points, and appends the tick to the
 * observability store when the suite is on. It returns the samples so the
 * autoscaler reads the SAME counts. A cluster that can't be reached is
 * skipped, and the next tick retries it.
 */
export async function sampleQueueClusters(
  ctx: OrgContext,
  extra: { stack: string; cluster: string; queues: string[] }[] = [],
): Promise<SampledCluster[]> {
  const prefix = 'bull';
  const plan = new Map<string, { stack: string; cluster: string; queues: string[] | null }>();
  for (const c of studioClusters(ctx)) {
    if (c.purpose === 'queue' && c.online) plan.set(`${c.stack}/${c.cluster}`, { stack: c.stack, cluster: c.cluster, queues: null });
  }
  for (const e of extra) {
    const k = `${e.stack}/${e.cluster}`;
    const cur = plan.get(k);
    if (cur && cur.queues === null) continue; // already discovering everything
    plan.set(k, { stack: e.stack, cluster: e.cluster, queues: [...new Set([...(cur?.queues ?? []), ...e.queues])] });
  }

  const now = Date.now();
  const rows: QueueSampleRow[] = [];
  const out: SampledCluster[] = [];
  for (const p of plan.values()) {
    let target: StudioTarget;
    try {
      target = resolveStudioTarget(ctx, p);
    } catch {
      continue;
    }
    const eventsSince: Record<string, string> = {};
    for (const [k, v] of cursors) {
      const [org, stack, cluster, pre, queue] = k.split('|');
      if (org === ctx.activeOrgId && stack === p.stack && cluster === p.cluster && pre === prefix && v.lastId && queue) {
        eventsSince[queue] = v.lastId;
      }
    }
    let reply: QueueOverviewReply;
    try {
      reply = QueueOverviewReply.parse(
        await runOp(ctx, target, { kind: 'overview', prefix, queues: p.queues ?? [], eventsSince }),
      );
    } catch {
      continue;
    }
    out.push({ stack: p.stack, cluster: p.cluster, queues: reply.queues });
    for (const q of reply.queues) {
      const key = rateKey(ctx.activeOrgId, { ...p, prefix }, q.name);
      const point = ratePoint(cursors.get(key), now, q.events);
      cursors.set(key, { lastId: q.events.lastId, at: now });
      if (!point) continue;
      latestRates.set(key, point);
      rows.push({
        org_id: ctx.activeOrgId,
        stack: p.stack,
        cluster: p.cluster,
        prefix,
        queue: q.name,
        ts: chTime(now),
        interval_s: point.intervalSeconds,
        waiting: q.counts.wait + q.counts.paused,
        active: q.counts.active,
        delayed: q.counts.delayed,
        prioritized: q.counts.prioritized,
        failed: q.counts.failed,
        completed: q.counts.completed,
        paused: q.isPaused ? 1 : 0,
        completed_delta: point.completed,
        failed_delta: point.failed,
      });
    }
  }
  if (rows.length > 0) {
    const ch = await samplesStore(ctx).catch(() => null);
    await ch?.insert(QUEUE_SAMPLES_TABLE, rows).catch(() => undefined);
  }
  return out;
}

export interface StudioRatesView {
  status: 'disabled' | 'unreachable' | 'ok';
  points: QueueRateBucket[];
}

/** Throughput / failure series for one queue out of the observability store. */
export async function studioRates(ctx: OrgContext, input: StudioRatesInput): Promise<StudioRatesView> {
  const ch = await samplesStore(ctx).catch(() => null);
  if (!ch) return { status: 'disabled', points: [] };
  const rows = await ch.query<QueueRateBucket>(buildQueueRatesQuery(ch.database, ctx.activeOrgId, input));
  if (rows === null) return { status: 'unreachable', points: [] };
  return {
    status: 'ok',
    points: rows.map((r) => ({
      bucket: r.bucket,
      completed: Number(r.completed),
      failed: Number(r.failed),
      seconds: Number(r.seconds),
      waiting: Number(r.waiting),
    })),
  };
}

/** Tests: forget sampler memory. */
export function resetQueueSampler(): void {
  cursors.clear();
  latestRates.clear();
  ensuredSchema.clear();
}
