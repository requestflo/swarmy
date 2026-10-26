import { rollbackSpanWords, rollbackTookSec, type LastRollbackInput, type RollbackTimingView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { recordIncidentEvent } from './incidents-record';
import { rollbackSettle } from './rollback-settle';

/**
 * Rollback timing: how long a put-back took, start to healthy. Deployments
 * aren't persisted (a deploy's status is synthesised from live convergence),
 * so nothing else records it: the rollback's own release row carries both
 * instants. `markRollback` stamps the start (taken before dispatch) and what
 * it put back, then a watcher polls the live swarm every 2 s until every part
 * runs the put-back version with all its copies (`rollbackSettle`) and stamps
 * `healthyAt`. The watch lives in memory: a restart, Docker pausing the
 * update, or 15 minutes without settling leaves `healthyAt` null, so the
 * duration is unknown rather than wrong. One watch per app; a newer rollback
 * replaces it.
 */

export const ROLLBACK_WATCH_EVERY_MS = 2_000;
export const ROLLBACK_WATCH_FOR_MS = 15 * 60_000;

interface Watched {
  id: string;
  stackName: string;
  rollbackOf: string;
  startedAt: Date;
  images: Array<{ name: string; image: string }>;
}

const watches = new Map<string, () => void>();

function imagesOf(json: unknown): Watched['images'] {
  if (!Array.isArray(json)) return [];
  return (json as Array<{ name?: unknown; image?: unknown }>).flatMap((x) =>
    typeof x?.name === 'string' && typeof x?.image === 'string' ? [{ name: x.name, image: x.image }] : [],
  );
}

/** Record a rollback's start on its release and start watching it settle. */
export async function markRollback(
  ctx: OrgContext,
  input: { releaseId: string; rollbackOf: string; startedAt: Date; notes: string },
  opts: { everyMs?: number; forMs?: number } = {},
): Promise<void> {
  const row = await ctx.db.release.update({
    where: { id: input.releaseId },
    data: { notes: input.notes, rollbackOf: input.rollbackOf, startedAt: input.startedAt },
    select: { id: true, stackName: true, imagesJson: true },
  });
  watchRollback(ctx, { id: row.id, stackName: row.stackName, rollbackOf: input.rollbackOf, startedAt: input.startedAt, images: imagesOf(row.imagesJson) }, opts);
}

/** One look at the live swarm: stamps `healthyAt` once it settled. */
export async function checkRollback(ctx: OrgContext, w: Watched, now = new Date()): Promise<'rolling' | 'healthy' | 'failed'> {
  const state = rollbackSettle(ctx.hub.liveInventory(ctx.activeOrgId).services, w.images);
  if (state !== 'healthy') return state;
  const stamped = await ctx.db.release.updateMany({ where: { id: w.id, orgId: ctx.activeOrgId, healthyAt: null }, data: { healthyAt: now } });
  if (stamped.count === 0) return state;
  const tookSec = rollbackTookSec(w.startedAt, now);
  await writeAudit(ctx, {
    action: 'release.rollback.healthy',
    actorType: 'system',
    targetType: 'release',
    targetId: w.id,
    metadata: { stackName: w.stackName, rollbackOf: w.rollbackOf, tookSec },
  });
  // Only enriches an incident already open for the app's deploys; never opens one.
  await recordIncidentEvent(ctx, {
    groupKey: `release:${w.stackName}`,
    kind: 'deploy.rollback.healthy',
    message: `${w.stackName} is back on the put-back version. It took ${rollbackSpanWords(tookSec)}.`,
    meta: { releaseId: w.id, rollbackOf: w.rollbackOf, tookSec },
  }).catch(() => undefined);
  return state;
}

export function watchRollback(ctx: OrgContext, w: Watched, opts: { everyMs?: number; forMs?: number } = {}): void {
  const key = `${ctx.activeOrgId}\u0000${w.stackName}`;
  watches.get(key)?.();
  const until = Date.now() + (opts.forMs ?? ROLLBACK_WATCH_FOR_MS);
  let busy = false;
  const stop = (): void => {
    clearInterval(timer);
    if (watches.get(key) === stop) watches.delete(key);
  };
  const timer = setInterval(() => {
    if (busy) return;
    if (Date.now() > until) return stop();
    busy = true;
    void checkRollback(ctx, w)
      .then((state) => state !== 'rolling' && stop(), () => undefined)
      .finally(() => (busy = false));
  }, opts.everyMs ?? ROLLBACK_WATCH_EVERY_MS);
  (timer as { unref?: () => void }).unref?.();
  watches.set(key, stop);
}

/** The latest rollback with a measured duration, of one app or the estate. */
export async function lastRollback(ctx: OrgContext, input: LastRollbackInput): Promise<RollbackTimingView | null> {
  const row = await ctx.db.release.findFirst({
    where: { orgId: ctx.activeOrgId, rollbackOf: { not: null }, startedAt: { not: null }, healthyAt: { not: null }, ...(input.stackName ? { stackName: input.stackName } : {}) },
    orderBy: { healthyAt: 'desc' },
    select: { id: true, stackName: true, rollbackOf: true, startedAt: true, healthyAt: true },
  });
  if (!row?.rollbackOf || !row.startedAt || !row.healthyAt) return null;
  return {
    releaseId: row.id,
    stackName: row.stackName,
    rollbackOf: row.rollbackOf,
    startedAt: row.startedAt.toISOString(),
    healthyAt: row.healthyAt.toISOString(),
    tookSec: rollbackTookSec(row.startedAt, row.healthyAt),
  };
}
