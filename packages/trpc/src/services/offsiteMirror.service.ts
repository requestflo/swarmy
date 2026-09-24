/**
 * Off-site mirror service — swarmy's Garage object store (backups, edge certs,
 * app buckets) mirrored into an S3 `BackupTarget` off the cluster, and restored
 * back from it after a cluster loss.
 *
 * Config is swarmy's own (like the backup targets it points at), so it lives in
 * Postgres: one `OffsiteMirror` row per org + an `OffsiteMirrorRun` history.
 * The engine is a `container.runOnce` rclone one-shot dispatched via a swarm
 * manager on the `swarmy` overlay (reaches `http://swarmy-garage:3900`); every
 * credential rides as container ENV only (see `offsiteMirror.core.ts`). The
 * mirror reads Garage with its own controller-held key (vault-encrypted on the
 * row), granted per bucket through the Garage admin flow.
 *
 * Runs can take hours, so `mirrorNow`/`restoreFromOffsite` record a RUNNING
 * row and return; the dispatch completes in the background and closes the row.
 * The scheduler (`apps/api/src/workers/offsite-mirror.ts`) calls
 * `runDueMirrors` once a minute.
 */
import type { AgentHub } from '../hub/types';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import type { RunOnceResult } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resticNetworkFor, SWARMY_OVERLAY_NETWORK } from './backups.service';
import {
  createBucket,
  createKey,
  garageS3Endpoint,
  grantKeyOnBucket,
  listKeys,
  overview as bucketsOverview,
} from './buckets.service';
import { systemContext } from './cicd.service';
import { resolveManagerNode } from './dispatch.service';
import {
  buildMirrorRunOnce,
  DEFAULT_EVERY_MINUTES,
  DEFAULT_GRACE_DAYS,
  isMirrorDue,
  MIRROR_KEY_NAME,
  MIRROR_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
  mirrorNextRunAt,
  normalizePrefix,
  offsiteRoot,
  offsiteTargetProblem,
  parseOffsiteBucketList,
  planMirrorBuckets,
  restoreGuard,
  STALE_RUN_MS,
  summarizeRun,
  type BucketRunStats,
  type MirrorMode,
  type OffsiteTargetLike,
  type RunSummary,
  type S3RemoteConfig,
} from './offsiteMirror.core';

export * from './offsiteMirror.core';

// ── row shapes ───────────────────────────────────────────────────────────────

interface MirrorRow {
  id: string;
  orgId: string;
  targetId: string;
  allBuckets: boolean;
  buckets: unknown;
  prefix: string;
  everyMinutes: number;
  mode: string;
  graceDays: number;
  enabled: boolean;
  sourceAccessKeyRef: string | null;
  sourceSecretKeyRef: string | null;
  createdAt: Date;
}

// ── run state (derived or in memory, never stored on the config row) ─────────

/**
 * Garage bucket ids the mirror key has been granted on, per mirror. A cache
 * only: Garage's allow is idempotent, so after a restart the first run simply
 * re-grants. Reset whenever the key is re-minted.
 */
const grantedByMirror = new Map<string, Set<string>>();

/**
 * Mirrors re-enabled or re-pointed at a new destination since their last run:
 * their first copy starts on the next tick instead of waiting for the slot.
 * Process-local; a restart just falls back to the regular slot.
 */
const armedNow = new Set<string>();

/** Newest store → off-site run (any trigger / outcome) — the "last run". */
async function lastMirrorRunAt(db: DB, mirrorId: string): Promise<Date | null> {
  const last = (await db.offsiteMirrorRun.findFirst({
    where: { mirrorId, direction: 'mirror' },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  })) as { startedAt: Date } | null;
  return last?.startedAt ?? null;
}

/** Derived next scheduled run; null = due on the next tick. */
function nextRunOf(row: MirrorRow, lastRunAt: Date | null): Date | null {
  if (armedNow.has(row.id)) return null;
  return mirrorNextRunAt(row.everyMinutes, row.createdAt, lastRunAt);
}

interface TargetRow {
  id: string;
  name: string;
  kind: string;
  endpoint: string | null;
  bucket: string;
  region: string | null;
  credentialRef: string | null;
  secretKeyRef: string | null;
}

interface RunRow {
  id: string;
  direction: string;
  trigger: string;
  status: string;
  objectsCopied: number;
  bytesCopied: bigint;
  deletes: number;
  errorCount: number;
  buckets: unknown;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

// ── views ────────────────────────────────────────────────────────────────────

export interface MirrorRunView {
  id: string;
  direction: 'mirror' | 'restore';
  trigger: 'schedule' | 'manual';
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  objectsCopied: number;
  /** BigInt as a decimal string. */
  bytesCopied: string;
  deletes: number;
  errorCount: number;
  buckets: BucketRunStats[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface OffsiteDestinationView {
  id: string;
  name: string;
  endpoint: string | null;
  bucket: string;
  eligible: boolean;
  reason: string | null;
}

export interface OffsiteMirrorConfigView {
  targetId: string;
  targetName: string;
  allBuckets: boolean;
  buckets: string[];
  prefix: string;
  /** `<offsite bucket>/<prefix>` the buckets land under. */
  root: string;
  everyMinutes: number;
  mode: MirrorMode;
  graceDays: number;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface OffsiteMirrorView {
  mirror: OffsiteMirrorConfigView | null;
  running: boolean;
  lastRun: MirrorRunView | null;
  lastSuccessAt: string | null;
  runs: MirrorRunView[];
  destinations: OffsiteDestinationView[];
}

// ── helpers ──────────────────────────────────────────────────────────────────

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const asMode = (m: string): MirrorMode => (m === 'sync' ? 'sync' : 'copy');

function targetLike(t: TargetRow): OffsiteTargetLike {
  return {
    name: t.name,
    kind: t.kind,
    endpoint: t.endpoint,
    bucket: t.bucket,
    hasCredentials: Boolean(t.credentialRef && t.secretKeyRef),
    inCluster: resticNetworkFor(t.endpoint) !== undefined,
  };
}

function offsiteRemote(t: TargetRow): S3RemoteConfig {
  return {
    endpoint: t.endpoint,
    region: t.region,
    accessKeyId: t.credentialRef ? decryptSecret(t.credentialRef) : '',
    secretAccessKey: t.secretKeyRef ? decryptSecret(t.secretKeyRef) : '',
  };
}

function toRunView(r: RunRow): MirrorRunView {
  return {
    id: r.id,
    direction: r.direction === 'restore' ? 'restore' : 'mirror',
    trigger: r.trigger === 'manual' ? 'manual' : 'schedule',
    status: r.status === 'SUCCEEDED' ? 'SUCCEEDED' : r.status === 'FAILED' ? 'FAILED' : 'RUNNING',
    objectsCopied: r.objectsCopied,
    bytesCopied: r.bytesCopied.toString(),
    deletes: r.deletes,
    errorCount: r.errorCount,
    buckets: Array.isArray(r.buckets) ? (r.buckets as BucketRunStats[]) : [],
    error: r.error,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
  };
}

async function loadMirror(db: DB, orgId: string): Promise<MirrorRow | null> {
  return (await db.offsiteMirror.findUnique({ where: { orgId } })) as unknown as MirrorRow | null;
}

async function loadTarget(ctx: OrgContext, id: string): Promise<TargetRow> {
  const row = (await ctx.db.backupTarget.findFirst({
    where: { id, orgId: ctx.activeOrgId },
  })) as unknown as TargetRow | null;
  if (!row) throw notFound('backup target', id);
  return row;
}

/** Orgs with a run dispatched from THIS process (the long dispatch is in flight). */
const inflight = new Set<string>();

/** A RUNNING row that isn't orphaned (younger than the hard timeout + margin). */
async function hasLiveRun(db: DB, mirrorId: string, now = new Date()): Promise<boolean> {
  const n = await db.offsiteMirrorRun.count({
    where: {
      mirrorId,
      status: 'RUNNING',
      startedAt: { gt: new Date(now.getTime() - STALE_RUN_MS) },
    },
  });
  return n > 0;
}

async function isRunning(db: DB, mirror: MirrorRow): Promise<boolean> {
  return inflight.has(mirror.orgId) || (await hasLiveRun(db, mirror.id));
}

// ── queries ──────────────────────────────────────────────────────────────────

export async function getMirror(ctx: OrgContext): Promise<OffsiteMirrorView> {
  const [row, targets] = await Promise.all([
    loadMirror(ctx.db, ctx.activeOrgId),
    ctx.db.backupTarget.findMany({
      where: { orgId: ctx.activeOrgId },
      orderBy: { createdAt: 'desc' },
    }) as unknown as Promise<TargetRow[]>,
  ]);
  const destinations: OffsiteDestinationView[] = targets.map((t) => {
    const reason = offsiteTargetProblem(targetLike(t));
    return {
      id: t.id,
      name: t.name,
      endpoint: t.endpoint,
      bucket: t.bucket,
      eligible: reason === null,
      reason,
    };
  });
  if (!row) {
    return { mirror: null, running: false, lastRun: null, lastSuccessAt: null, runs: [], destinations };
  }
  const [runs, lastOk, running, lastRunAt] = await Promise.all([
    ctx.db.offsiteMirrorRun.findMany({
      where: { mirrorId: row.id },
      orderBy: { startedAt: 'desc' },
      take: 10,
    }) as unknown as Promise<RunRow[]>,
    ctx.db.offsiteMirrorRun.findFirst({
      where: { mirrorId: row.id, direction: 'mirror', status: 'SUCCEEDED' },
      orderBy: { startedAt: 'desc' },
      select: { finishedAt: true, startedAt: true },
    }),
    isRunning(ctx.db, row),
    lastMirrorRunAt(ctx.db, row.id),
  ]);
  const nextRunAt = row.enabled ? (nextRunOf(row, lastRunAt) ?? new Date()) : null;
  const target = targets.find((t) => t.id === row.targetId);
  let root = '';
  try {
    root = target ? offsiteRoot(target.bucket, row.prefix) : '';
  } catch {
    root = '';
  }
  const runViews = runs.map(toRunView);
  return {
    mirror: {
      targetId: row.targetId,
      targetName: target?.name ?? '',
      allBuckets: row.allBuckets,
      buckets: strList(row.buckets),
      prefix: row.prefix,
      root,
      everyMinutes: row.everyMinutes,
      mode: asMode(row.mode),
      graceDays: row.graceDays,
      enabled: row.enabled,
      lastRunAt: lastRunAt?.toISOString() ?? null,
      nextRunAt: nextRunAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    },
    running,
    lastRun: runViews[0] ?? null,
    lastSuccessAt: (lastOk?.finishedAt ?? lastOk?.startedAt)?.toISOString() ?? null,
    runs: runViews,
    destinations,
  };
}

/**
 * Resilience input: is there an off-site copy, and how fresh? Pure DB — the
 * resilience snapshot calls this on every page load.
 */
export async function offsiteSignal(
  ctx: OrgContext,
): Promise<{ configured: boolean; enabled: boolean; lastSuccessAt: string | null; since: string | null }> {
  const row = await loadMirror(ctx.db, ctx.activeOrgId);
  if (!row) return { configured: false, enabled: false, lastSuccessAt: null, since: null };
  const lastOk = await ctx.db.offsiteMirrorRun.findFirst({
    where: { mirrorId: row.id, direction: 'mirror', status: 'SUCCEEDED' },
    orderBy: { startedAt: 'desc' },
    select: { finishedAt: true, startedAt: true },
  });
  return {
    configured: true,
    enabled: row.enabled,
    lastSuccessAt: (lastOk?.finishedAt ?? lastOk?.startedAt)?.toISOString() ?? null,
    since: row.createdAt.toISOString(),
  };
}

// ── config mutations ─────────────────────────────────────────────────────────

export interface SaveMirrorInput {
  targetId: string;
  allBuckets: boolean;
  buckets?: string[];
  prefix?: string;
  everyMinutes?: number;
  mode?: MirrorMode;
  graceDays?: number;
  enabled?: boolean;
}

export async function saveMirror(ctx: OrgContext, input: SaveMirrorInput): Promise<OffsiteMirrorView> {
  const target = await loadTarget(ctx, input.targetId);
  const problem = offsiteTargetProblem(targetLike(target));
  if (problem) throw commandRejected(`${target.name}: ${problem}`);
  let prefix: string;
  try {
    prefix = normalizePrefix(input.prefix);
  } catch (e) {
    throw commandRejected(e instanceof Error ? e.message : String(e));
  }
  const buckets = [...new Set(input.buckets ?? [])].sort();
  if (!input.allBuckets && buckets.length === 0) {
    throw commandRejected('pick at least one bucket, or mirror every bucket');
  }
  const everyMinutes = input.everyMinutes ?? DEFAULT_EVERY_MINUTES;
  const enabled = input.enabled ?? true;
  const existing = await loadMirror(ctx.db, ctx.activeOrgId);
  const data = {
    targetId: target.id,
    allBuckets: input.allBuckets,
    buckets,
    prefix,
    everyMinutes,
    mode: input.mode ?? 'copy',
    graceDays: input.graceDays ?? DEFAULT_GRACE_DAYS,
    enabled,
  };
  await ctx.db.offsiteMirror.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId, ...data },
    update: data,
  });
  // A new mirror has never run, so it is due on the next tick anyway;
  // re-enabled / re-pointed ones are armed to copy on the next tick too.
  if (existing) {
    if (enabled && (!existing.enabled || existing.targetId !== target.id)) armedNow.add(existing.id);
    if (!enabled) armedNow.delete(existing.id);
  }
  await writeAudit(ctx, {
    action: existing ? 'offsite.mirror.update' : 'offsite.mirror.create',
    targetType: 'backupTarget',
    targetId: target.id,
    metadata: {
      target: target.name,
      allBuckets: input.allBuckets,
      buckets,
      prefix,
      everyMinutes,
      mode: data.mode,
      graceDays: data.graceDays,
      enabled,
    },
  });
  return getMirror(ctx);
}

export async function removeMirror(ctx: OrgContext): Promise<{ removed: boolean }> {
  const row = await loadMirror(ctx.db, ctx.activeOrgId);
  if (!row) return { removed: false };
  if (await isRunning(ctx.db, row)) {
    throw commandRejected('a mirror or restore is running — wait for it to finish');
  }
  await ctx.db.offsiteMirror.delete({ where: { id: row.id } });
  armedNow.delete(row.id);
  grantedByMirror.delete(row.id);
  await writeAudit(ctx, {
    action: 'offsite.mirror.remove',
    targetType: 'backupTarget',
    targetId: row.targetId,
    // The off-site copy itself is left untouched — removing the config never deletes data.
    metadata: { prefix: row.prefix },
  });
  return { removed: true };
}

// ── source key + grants ──────────────────────────────────────────────────────

/**
 * The mirror's own Garage key. Reused while Garage still knows it; re-minted
 * when it doesn't (e.g. a controller restored onto a brand-new store), which
 * also resets the per-bucket grant cache.
 */
async function ensureSourceKey(
  ctx: OrgContext,
  row: MirrorRow,
): Promise<{ accessKeyId: string; secretAccessKey: string; granted: Set<string> }> {
  if (row.sourceAccessKeyRef && row.sourceSecretKeyRef) {
    const accessKeyId = decryptSecret(row.sourceAccessKeyRef);
    const keys = await listKeys(ctx);
    if (keys.state !== 'ready') throw commandRejected('object store unreachable — try again shortly');
    if (keys.keys.some((k) => k.id === accessKeyId)) {
      let granted = grantedByMirror.get(row.id);
      if (!granted) grantedByMirror.set(row.id, (granted = new Set()));
      return { accessKeyId, secretAccessKey: decryptSecret(row.sourceSecretKeyRef), granted };
    }
  }
  const key = await createKey(ctx, MIRROR_KEY_NAME);
  await ctx.db.offsiteMirror.update({
    where: { id: row.id },
    data: {
      sourceAccessKeyRef: encryptSecret(key.accessKeyId),
      sourceSecretKeyRef: encryptSecret(key.secretAccessKey),
    },
  });
  const granted = new Set<string>();
  grantedByMirror.set(row.id, granted);
  return { accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, granted };
}

/** Grant the mirror key read+write on each bucket it hasn't been granted yet
 *  (per the in-memory cache — `key.granted` is that cache's live set). */
async function ensureGrants(
  ctx: OrgContext,
  key: { accessKeyId: string; granted: Set<string> },
  bucketIds: string[],
): Promise<void> {
  const todo = bucketIds.filter((id) => !key.granted.has(id));
  if (todo.length === 0) return;
  for (const bucketId of todo) {
    await grantKeyOnBucket(ctx, {
      bucketId,
      accessKeyId: key.accessKeyId,
      // write is only exercised by a restore; the mirror direction only reads.
      permissions: { read: true, write: true, owner: false },
      mode: 'allow',
    });
    key.granted.add(bucketId);
  }
}

// ── run recording ────────────────────────────────────────────────────────────

/** Close a run row with its outcome (exported for tests). */
export async function finishRun(
  db: DB,
  runId: string,
  summary: RunSummary,
  now: Date = new Date(),
): Promise<void> {
  await db.offsiteMirrorRun.update({
    where: { id: runId },
    data: {
      status: summary.status,
      objectsCopied: summary.objectsCopied,
      bytesCopied: BigInt(Math.max(0, Math.round(summary.bytesCopied))),
      deletes: summary.deletes,
      errorCount: summary.errorCount,
      buckets: summary.buckets as unknown as object,
      error: summary.error,
      finishedAt: now,
    },
  });
}

/** Summary for a run that never produced rclone output (dispatch/setup failed). */
export function failedSummary(e: unknown): RunSummary {
  return {
    status: 'FAILED',
    objectsCopied: 0,
    bytesCopied: 0,
    deletes: 0,
    errorCount: 1,
    buckets: [],
    error: (e instanceof Error ? e.message : String(e)).slice(0, 2000),
  };
}

/** Orphaned RUNNING rows (controller restarted mid-dispatch) → FAILED. */
export async function reapStaleRuns(db: DB, now: Date = new Date()): Promise<number> {
  const res = await db.offsiteMirrorRun.updateMany({
    where: { status: 'RUNNING', startedAt: { lte: new Date(now.getTime() - STALE_RUN_MS) } },
    data: {
      status: 'FAILED',
      error: 'run lost — the controller restarted before it reported back',
      finishedAt: now,
    },
  });
  return res.count;
}

interface Dispatched {
  runId: string;
  /** Resolves once the run row is closed (never rejects). */
  done: Promise<RunSummary>;
}

/** Dispatch the one-shot and close the run row when it returns. */
function dispatchRun(
  ctx: OrgContext,
  args: {
    mirror: MirrorRow;
    runId: string;
    nodeId: string;
    payload: ReturnType<typeof buildMirrorRunOnce>;
    direction: 'mirror' | 'restore';
    extraErrors?: BucketRunStats[];
    target: TargetRow;
  },
): Promise<RunSummary> {
  return (async () => {
    let summary: RunSummary;
    try {
      const res = await ctx.hub.dispatch<RunOnceResult>(
        args.nodeId,
        'container.runOnce',
        args.payload,
        { timeoutMs: MIRROR_TIMEOUT_MS + 5 * 60_000 },
      );
      summary = summarizeRun(res);
    } catch (e) {
      summary = failedSummary(mapDispatchError(e));
    }
    if (args.extraErrors?.length) {
      summary = {
        ...summary,
        buckets: [...summary.buckets, ...args.extraErrors],
        errorCount: summary.errorCount + args.extraErrors.length,
        error:
          summary.error ??
          `${args.extraErrors.map((b) => b.bucket).join(', ')}: not in the object store any more`,
      };
    }
    try {
      await finishRun(ctx.db, args.runId, summary);
    } catch {
      // row gone (mirror removed) — nothing to record against
    }
    await writeAudit(ctx, {
      action: args.direction === 'restore' ? 'offsite.restore' : 'offsite.mirror.run',
      actorType: ctx.user ? 'user' : 'system',
      targetType: 'backupTarget',
      targetId: args.target.id,
      metadata: {
        runId: args.runId,
        status: summary.status,
        objectsCopied: summary.objectsCopied,
        bytesCopied: summary.bytesCopied,
        deletes: summary.deletes,
        errorCount: summary.errorCount,
        ...(summary.error ? { error: summary.error.slice(0, 500) } : {}),
      },
    });
    return summary;
  })().finally(() => inflight.delete(args.mirror.orgId));
}

async function prepare(
  ctx: OrgContext,
): Promise<{ mirror: MirrorRow; target: TargetRow }> {
  const mirror = await loadMirror(ctx.db, ctx.activeOrgId);
  if (!mirror) throw commandRejected('no off-site mirror is configured');
  const target = await loadTarget(ctx, mirror.targetId);
  return { mirror, target };
}

/**
 * Start one store → off-site run. Throws (nothing recorded) when it can't
 * start; otherwise records RUNNING and returns while the copy proceeds.
 */
export async function startMirrorRun(
  ctx: OrgContext,
  opts: { trigger: 'schedule' | 'manual' },
): Promise<Dispatched> {
  const { mirror, target } = await prepare(ctx);
  const problem = offsiteTargetProblem(targetLike(target));
  if (problem) throw commandRejected(`${target.name}: ${problem}`);
  if (await isRunning(ctx.db, mirror)) {
    throw commandRejected('a mirror or restore is already running');
  }
  inflight.add(mirror.orgId);
  try {
    const store = await bucketsOverview(ctx);
    if (store.state !== 'ready') {
      throw commandRejected(
        store.state === 'disabled'
          ? 'object storage is off — nothing to mirror'
          : `object store unreachable: ${store.message ?? 'try again shortly'}`,
      );
    }
    const mode = asMode(mirror.mode);
    const plan = planMirrorBuckets({
      allBuckets: mirror.allBuckets,
      selected: strList(mirror.buckets),
      mode,
      store: store.buckets.map((b) => ({ id: b.id, name: b.name, objects: b.objects })),
    });
    const key = await ensureSourceKey(ctx, mirror);
    await ensureGrants(ctx, key, plan.buckets.map((b) => b.id));
    const node = await resolveManagerNode(ctx);
    const run = await ctx.db.offsiteMirrorRun.create({
      data: {
        orgId: ctx.activeOrgId,
        mirrorId: mirror.id,
        direction: 'mirror',
        trigger: opts.trigger,
        status: 'RUNNING',
        hostNodeId: node.id,
        actorId: ctx.user?.id ?? null,
      },
    });
    const extraErrors: BucketRunStats[] = plan.missing.map((bucket) => ({
      bucket,
      objects: 0,
      bytes: 0,
      deletes: 0,
      errors: 1,
      exitCode: null,
      lastError: 'not in the object store any more',
    }));
    if (plan.buckets.length === 0) {
      // Nothing to copy (empty store, or every selected bucket is gone): close now.
      const summary: RunSummary = {
        status: extraErrors.length ? 'FAILED' : 'SUCCEEDED',
        objectsCopied: 0,
        bytesCopied: 0,
        deletes: 0,
        errorCount: extraErrors.length,
        buckets: extraErrors,
        error: extraErrors.length ? 'none of the selected buckets exist any more' : null,
      };
      await finishRun(ctx.db, run.id, summary);
      inflight.delete(mirror.orgId);
      return { runId: run.id, done: Promise.resolve(summary) };
    }
    const payload = buildMirrorRunOnce({
      direction: 'mirror',
      source: {
        endpoint: garageS3Endpoint(),
        region: store.region,
        accessKeyId: key.accessKeyId,
        secretAccessKey: key.secretAccessKey,
        provider: 'Other',
      },
      offsite: offsiteRemote(target),
      root: offsiteRoot(target.bucket, mirror.prefix),
      buckets: plan.buckets.map((b) => b.name),
      copyOnly: plan.copyOnly,
      mode,
      graceDays: mirror.graceDays,
      runId: run.id,
      network: SWARMY_OVERLAY_NETWORK,
    });
    const done = dispatchRun(ctx, {
      mirror,
      runId: run.id,
      nodeId: node.id,
      payload,
      direction: 'mirror',
      extraErrors,
      target,
    });
    return { runId: run.id, done };
  } catch (e) {
    inflight.delete(mirror.orgId);
    throw e;
  }
}

/** "Mirror now" — admin-triggered run. Returns once the run is recorded. */
export async function mirrorNow(ctx: OrgContext): Promise<{ runId: string }> {
  const { runId, done } = await startMirrorRun(ctx, { trigger: 'manual' });
  void done;
  await writeAudit(ctx, {
    action: 'offsite.mirror.start',
    targetType: 'offsiteMirrorRun',
    targetId: runId,
  });
  return { runId };
}

// ── restore direction ────────────────────────────────────────────────────────

/** Bucket folders present in the off-site copy (the restore dialog's preview). */
export async function listOffsiteBuckets(
  ctx: OrgContext,
): Promise<{ root: string; buckets: string[] }> {
  const { mirror, target } = await prepare(ctx);
  const problem = offsiteTargetProblem(targetLike(target));
  if (problem) throw commandRejected(`${target.name}: ${problem}`);
  const root = offsiteRoot(target.bucket, mirror.prefix);
  const node = await resolveManagerNode(ctx);
  let res: RunOnceResult;
  try {
    res = await ctx.hub.dispatch<RunOnceResult>(
      node.id,
      'container.runOnce',
      buildMirrorRunOnce({
        direction: 'list',
        offsite: offsiteRemote(target),
        root,
        buckets: [],
        // list only needs egress, but the overlay also has it — keep one path.
        network: SWARMY_OVERLAY_NETWORK,
      }),
      { timeoutMs: LIST_TIMEOUT_MS + 30_000 },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
  if (res.exitCode !== 0) {
    const tail = res.output.trim().slice(-300);
    // An empty/new prefix is "nothing off-site yet", not an error.
    if (/directory not found/i.test(tail)) return { root, buckets: [] };
    throw commandRejected(`could not list the off-site copy: ${tail || `rclone exited ${res.exitCode}`}`);
  }
  return { root, buckets: parseOffsiteBucketList(res.output) };
}

export interface RestoreInput {
  /** Must equal the destination's name — the typed confirmation. */
  confirm: string;
  /** Restore only these buckets (default: every bucket found off-site). */
  buckets?: string[];
}

/**
 * "Restore from offsite": copy the off-site copy back into Garage — the path
 * back after losing the cluster. Admin-only (router), confirmed (typed
 * destination name), audited (start + outcome). Always `copy`: nothing in
 * Garage is ever deleted or overwritten with an older object's checksum match.
 * Missing buckets are created first.
 */
export async function restoreFromOffsite(
  ctx: OrgContext,
  input: RestoreInput,
): Promise<{ runId: string; buckets: string[] }> {
  const mirror = await loadMirror(ctx.db, ctx.activeOrgId);
  const target = mirror ? await loadTarget(ctx, mirror.targetId) : null;
  const store = await bucketsOverview(ctx);
  const running = mirror ? await isRunning(ctx.db, mirror) : false;
  const refusal = restoreGuard({
    confirm: input.confirm,
    target: target ? targetLike(target) : null,
    storeState: store.state,
    running,
  });
  if (refusal || !mirror || !target) {
    await writeAudit(ctx, {
      action: 'offsite.restore.refused',
      targetType: 'backupTarget',
      targetId: target?.id,
      metadata: { reason: refusal ?? 'no mirror' },
    });
    throw commandRejected(refusal ?? 'no off-site mirror is configured');
  }

  inflight.add(mirror.orgId);
  try {
    const offsite = await listOffsiteBuckets(ctx);
    let buckets = offsite.buckets;
    if (input.buckets?.length) {
      const unknown = input.buckets.filter((b) => !offsite.buckets.includes(b));
      if (unknown.length) {
        throw commandRejected(`not in the off-site copy: ${unknown.join(', ')}`);
      }
      buckets = [...new Set(input.buckets)].sort();
    }
    if (buckets.length === 0) throw commandRejected(`nothing to restore under ${offsite.root}`);

    // Recreate missing buckets, then grant the mirror key on every target bucket.
    const byName = new Map(store.buckets.map((b) => [b.name, b.id]));
    for (const name of buckets) {
      if (!byName.has(name)) {
        const created = await createBucket(ctx, { name });
        byName.set(name, created.id);
      }
    }
    const key = await ensureSourceKey(ctx, mirror);
    await ensureGrants(
      ctx,
      key,
      buckets.map((b) => byName.get(b)!).filter(Boolean),
    );
    const node = await resolveManagerNode(ctx);
    const run = await ctx.db.offsiteMirrorRun.create({
      data: {
        orgId: ctx.activeOrgId,
        mirrorId: mirror.id,
        direction: 'restore',
        trigger: 'manual',
        status: 'RUNNING',
        hostNodeId: node.id,
        actorId: ctx.user?.id ?? null,
      },
    });
    await writeAudit(ctx, {
      action: 'offsite.restore.start',
      targetType: 'backupTarget',
      targetId: target.id,
      metadata: { runId: run.id, buckets, root: offsite.root },
    });
    const payload = buildMirrorRunOnce({
      direction: 'restore',
      source: {
        endpoint: garageS3Endpoint(),
        region: store.region,
        accessKeyId: key.accessKeyId,
        secretAccessKey: key.secretAccessKey,
        provider: 'Other',
      },
      offsite: offsiteRemote(target),
      root: offsite.root,
      buckets,
      network: SWARMY_OVERLAY_NETWORK,
      runId: run.id,
    });
    void dispatchRun(ctx, {
      mirror,
      runId: run.id,
      nodeId: node.id,
      payload,
      direction: 'restore',
      target,
    });
    return { runId: run.id, buckets };
  } catch (e) {
    inflight.delete(mirror.orgId);
    throw e;
  }
}

// ── scheduler entry (apps/api/src/workers/offsite-mirror.ts) ──────────────────

export interface OffsiteMirrorDeps {
  db: DB;
  hub: AgentHub;
  auth: Auth;
}

/**
 * One scheduler tick: reap orphaned runs, then start every due mirror whose
 * org has a connected manager. Due-ness is derived from run history (the slot
 * after the newest mirror run); every fire writes a run row — RUNNING before
 * the copy starts, or FAILED when it can't start (so the card shows why) — so a
 * slow or failing run never double-fires.
 */
export async function runDueMirrors(
  deps: OffsiteMirrorDeps,
  now: Date = new Date(),
): Promise<{ started: string[] }> {
  await reapStaleRuns(deps.db, now).catch(() => 0);
  const enabled = (await deps.db.offsiteMirror.findMany({
    where: { enabled: true },
  })) as unknown as MirrorRow[];
  const started: string[] = [];
  for (const m of enabled) {
    try {
      if (!deps.hub.managerNode(m.orgId)) continue; // cluster not warm — next tick
      const nextRunAt = nextRunOf(m, await lastMirrorRunAt(deps.db, m.id));
      if (!isMirrorDue({ enabled: m.enabled, nextRunAt }, now, await isRunning(deps.db, m))) continue;
      armedNow.delete(m.id);
      const ctx = systemContext(deps, m.orgId);
      try {
        const { runId } = await startMirrorRun(ctx, { trigger: 'schedule' });
        started.push(runId);
      } catch (e) {
        const run = await deps.db.offsiteMirrorRun.create({
          data: {
            orgId: m.orgId,
            mirrorId: m.id,
            direction: 'mirror',
            trigger: 'schedule',
            status: 'RUNNING',
            startedAt: now,
          },
        });
        await finishRun(deps.db, run.id, failedSummary(e), now);
      }
    } catch {
      // one org's failure never kills the tick
    }
  }
  return { started };
}
