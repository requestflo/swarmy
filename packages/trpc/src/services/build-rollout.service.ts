/**
 * The rollout stage: the deploy that follows a build (git apps), linked back
 * to the build and timed until the swarm runs the digest.
 *
 * {@link rollOutBuilds} wraps the app's compose deploy: the rollout starts as
 * the deploy is dispatched, the Release it records is linked to each build
 * (`Build.releaseId`), and a bounded background watch reads the live swarm
 * ({@link rolloutProgress}) until every copy runs the digest — or Docker rolls
 * it back, pauses it, or the watch runs out. Never blocks or fails the deploy.
 */
import type { OrgContext } from '../context';
import { digestOf, rolloutProgress } from './build-rollout';
import { failureLine, type RolloutFacts } from './build-stages';
import { finishStage, noteStage, startStage } from './build-stages.service';

export const ROLLOUT_WATCH_MS = 10 * 60_000;
const POLL_MS = 2_000;

/** The newest watch per build: a re-deploy of the same build supersedes the older watch. */
const watches = new Map<string, number>();
let nextWatch = 1;

export async function rollOutBuilds<T extends { releaseId: string | null }>(
  ctx: OrgContext,
  input: { stack: string; builds: ReadonlyArray<{ id: string; image: string }>; composeSource: string },
  deploy: () => Promise<T>,
): Promise<T> {
  // Only builds whose digest this compose actually deploys.
  const builds = input.builds.filter((b) => {
    const d = digestOf(b.image);
    return d !== null && input.composeSource.includes(d);
  });
  if (builds.length === 0) return deploy();
  const at = new Date();
  await Promise.all(builds.map((b) => startStage(ctx.db, b.id, 'rollout', at)));
  let res: T;
  try {
    res = await deploy();
  } catch (e) {
    await Promise.all(builds.map((b) => finishStage(ctx.db, b.id, 'rollout', 'failed', { error: failureLine(e) })));
    throw e;
  }
  if (res.releaseId) {
    await ctx.db.build
      .updateMany({ where: { id: { in: builds.map((b) => b.id) }, orgId: ctx.activeOrgId }, data: { releaseId: res.releaseId } })
      .catch(() => undefined);
  }
  for (const b of builds) void watchRollout(ctx, input.stack, b).catch(() => undefined);
  return res;
}

/** Poll the live swarm until the build's digest runs everywhere it should (bounded). */
export async function watchRollout(
  ctx: OrgContext,
  stack: string,
  build: { id: string; image: string },
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void>; watchMs?: number } = {},
): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const digest = digestOf(build.image);
  if (!digest) return;
  const me = nextWatch++;
  watches.set(build.id, me);
  const until = now() + (deps.watchMs ?? ROLLOUT_WATCH_MS);
  let seen = '';
  let last: RolloutFacts | undefined;
  try {
    while (now() < until) {
      await sleep(POLL_MS);
      if (watches.get(build.id) !== me) return; // a newer deploy of this build took over
      const p = rolloutProgress(ctx.hub.liveInventory(ctx.activeOrgId).services, digest, stack);
      if (p.state === 'waiting') continue;
      last = p.facts;
      if (p.state === 'done') return await finishStage(ctx.db, build.id, 'rollout', 'ok', { rollout: p.facts });
      if (p.state === 'failed')
        return await finishStage(ctx.db, build.id, 'rollout', 'failed', { rollout: p.facts, error: p.error });
      const key = JSON.stringify(p.facts);
      if (key !== seen) await noteStage(ctx.db, build.id, 'rollout', { rollout: p.facts });
      seen = key;
    }
    const mins = Math.round((deps.watchMs ?? ROLLOUT_WATCH_MS) / 60_000);
    await finishStage(ctx.db, build.id, 'rollout', 'failed', {
      ...(last ? { rollout: last } : {}),
      error: `not every copy was running after ${mins} minutes`,
    });
  } finally {
    if (watches.get(build.id) === me) watches.delete(build.id);
  }
}
