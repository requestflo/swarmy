/**
 * "Pause after this step", Resume and Abandon for a platform upgrade run
 * (plans/epic-platform-upgrades.md §2). The state machine is pure
 * (`platform-upgrade.pause.ts`); this is the API over the run row:
 *
 *   pause    sets / clears `options.pauseRequestedAt` on a RUNNING run. The
 *            driver reads it fresh after each finished step and halts the run
 *            `paused` on the next one — including the new controller that
 *            resumes the run after replacing itself.
 *   resume   paused → running; the worker (and this call) re-drive it.
 *   abandon  paused → abandoning; the driver puts back every finished,
 *            reversible step (health-gated, one at a time), then `abandoned`.
 *            Re-driven by the tick, so a controller restart carries it on.
 *
 * Every transition is audited through `writeAudit`.
 */
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { resumeRun, beginAbandon, withPauseRequest, abandonPreview, ACTIVE_RUN_STATUSES } from './platform-upgrade.pause';
import {
  defaultDeps,
  drivePlatformUpgrade,
  persist,
  runView,
  stateOf,
  type PlatformRunView,
  type PlatformUpgradeDeps,
  type RunOptions,
  type RunRow,
} from './platform-upgrade.service';

async function findRun(ctx: OrgContext, id: string): Promise<RunRow> {
  const row = await ctx.db.platformUpgradeRun.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('platform upgrade run', id);
  return row;
}

async function fresh(ctx: OrgContext, row: RunRow): Promise<PlatformRunView> {
  return runView((await ctx.db.platformUpgradeRun.findFirst({ where: { id: row.id, orgId: ctx.activeOrgId } })) ?? row);
}

/** Ask a running upgrade to stop after the step it is on (`pause: false` takes the request back). */
export async function requestPlatformPause(
  ctx: OrgContext,
  input: { id: string; pause: boolean },
  deps: Pick<PlatformUpgradeDeps, 'audit' | 'now'> = defaultDeps,
): Promise<PlatformRunView> {
  const row = await findRun(ctx, input.id);
  if (row.status !== 'running') throw commandRejected(`only a running upgrade can be paused (this one is ${row.status})`);
  const at = input.pause ? deps.now().toISOString() : null;
  const options = withPauseRequest(row.options as RunOptions | null, at, ctx.user?.id ?? null);
  const updated = await ctx.db.platformUpgradeRun.update({ where: { id: row.id }, data: { options: options as object } });
  await deps.audit(ctx, {
    action: input.pause ? 'platform.upgrade.pause' : 'platform.upgrade.pause.withdraw',
    targetType: 'platformUpgradeRun',
    targetId: row.id,
    metadata: { step: row.step, to: row.toVersion },
  });
  return runView(updated);
}

/** Carry a paused upgrade on from the step it stopped before. */
export async function resumePlatformUpgrade(ctx: OrgContext, id: string, deps: PlatformUpgradeDeps = defaultDeps): Promise<PlatformRunView> {
  const row = await findRun(ctx, id);
  const other = await ctx.db.platformUpgradeRun.findFirst({
    where: { orgId: ctx.activeOrgId, status: { in: ACTIVE_RUN_STATUSES }, NOT: { id } },
    select: { id: true },
  });
  if (other) throw commandRejected('another platform upgrade is running or paused');
  let run;
  try {
    run = resumeRun(stateOf(row), deps.now);
  } catch (e) {
    throw commandRejected(e instanceof Error ? e.message : String(e));
  }
  // Clear the request first, so the resumed drive doesn't pause again straight away.
  await ctx.db.platformUpgradeRun.update({ where: { id }, data: { options: withPauseRequest(row.options as RunOptions | null, null) as object } });
  await persist(ctx, id, run);
  await deps.audit(ctx, { action: 'platform.upgrade.resume', targetType: 'platformUpgradeRun', targetId: id, metadata: { step: run.step } });
  void drivePlatformUpgrade(ctx, id, deps);
  return fresh(ctx, row);
}

/** Give up on a paused upgrade: put back what can be put back (see `abandonPreview`), keep the rest. */
export async function abandonPlatformUpgrade(ctx: OrgContext, id: string, deps: PlatformUpgradeDeps = defaultDeps): Promise<PlatformRunView> {
  const row = await findRun(ctx, id);
  const state = stateOf(row);
  const preview = abandonPreview(state);
  let run;
  try {
    run = beginAbandon(state, deps.now);
  } catch (e) {
    throw commandRejected(e instanceof Error ? e.message : String(e));
  }
  await persist(ctx, id, run);
  await deps.audit(ctx, {
    action: 'platform.upgrade.abandon',
    targetType: 'platformUpgradeRun',
    targetId: id,
    metadata: { step: row.step, from: row.fromVersion, to: row.toVersion, putBack: preview.putBack, kept: preview.kept.map((k) => k.key) },
  });
  void drivePlatformUpgrade(ctx, id, deps);
  return fresh(ctx, row);
}
