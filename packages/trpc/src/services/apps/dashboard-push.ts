/**
 * Push webhooks for environments the dashboard declared (Clone as a new
 * environment). A clone tracks a branch like any environment, but a push to
 * production's branch (or a swarmy.yaml environment's) planned only the
 * file's environment, so a clone there redeployed only when the poll came
 * round. Every push now also plans each dashboard environment tracking the
 * pushed branch:
 *   - deduped against the poll: a head the environment's newest plan is
 *     already at (the poll got there first, or an earlier delivery) is not
 *     planned again — and the poll skips a head the webhook planned;
 *   - the same stale-push rule as any push: trigger `push` with the payload's
 *     `before`, so planCommit refuses a replayed older commit and honours a
 *     force-push back to it (stale-commit.ts).
 * Changed paths are left out: they are relative to the branch's previous
 * head, which a clone may not be running, so it builds like the poll does.
 */
import type { OrgContext } from '../../context';
import type { PlanCommitInput, PlanCommitResult } from '../apps.service';
import { dashboardEnvironments } from './dashboard-envs';

export interface DashboardPushInput {
  repoId: string;
  ref: string;
  sha: string | null;
  /** The sha the branch moved FROM (the payload's `before`). */
  before?: string | null;
}

export interface DashboardPushResult {
  /** Dashboard environments tracking the branch (planned or deduped). */
  tracked: string[];
  results: PlanCommitResult[];
}

type PlanFn = (ctx: OrgContext, input: PlanCommitInput) => Promise<PlanCommitResult>;

/** PURE — has this environment's newest plan already taken this head? */
export function alreadyAtHead(newestSha: string | null | undefined, sha: string | null): boolean {
  return Boolean(sha && newestSha && newestSha === sha);
}

export async function planDashboardPush(ctx: OrgContext, input: DashboardPushInput, plan: PlanFn): Promise<DashboardPushResult> {
  const tracked = (await dashboardEnvironments(ctx.db, input.repoId)).filter((e) => e.marker.branch === input.ref);
  const results: PlanCommitResult[] = [];
  for (const e of tracked) {
    const newest = await ctx.db.appPlan.findFirst({
      where: { repoId: input.repoId, environment: e.environment, prNumber: 0 },
      orderBy: { createdAt: 'desc' },
      select: { sha: true },
    });
    if (alreadyAtHead(newest?.sha, input.sha)) {
      results.push({ planId: null, status: 'skipped', environment: e.environment, stack: e.stack, reason: 'already planned' });
      continue;
    }
    const res = await plan(ctx, {
      repoId: input.repoId,
      ref: input.ref,
      sha: input.sha,
      trigger: 'push',
      environment: e.environment,
      before: input.before ?? null,
    }).catch((err: unknown): PlanCommitResult => ({
      planId: null,
      status: 'failed',
      environment: e.environment,
      stack: e.stack,
      reason: err instanceof Error ? err.message : String(err),
    }));
    results.push(res);
  }
  return { tracked: tracked.map((e) => e.environment), results };
}
