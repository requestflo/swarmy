/**
 * The rollback-by-replay guard (security review M8).
 *
 * A push webhook names a commit, and `planCommit` makes the environment match
 * it. A signed push for an OLD commit, replayed later (the delivery id is an
 * unsigned header; GitLab's token signs nothing), would therefore roll the
 * app back to that commit: its plan row is already `applied`, so the upsert
 * hands it back and the plan re-applies the old desired state over what runs.
 *
 * The rule, over swarmy's own history (no clone, no clocks): a PUSH of a
 * commit that already ran in this environment and has since been replaced by
 * another applied commit is not applied — unless the push itself moved the
 * branch away from the live commit (`before` = live sha: a force-push back,
 * i.e. an explicit revert in git). A new commit is never "older" (it has no
 * applied row); a redelivery of the live commit is a no-op plan; `git revert`
 * makes a new commit; and a dashboard deploy / retry (trigger `manual`, or a
 * retry) is a human's explicit choice and never passes through here.
 */
import type { DB } from '@swarmy/db';

export interface AppliedCommit {
  sha: string;
}

/** PURE — why this push must not apply, or null. `applied` is newest first. */
export function staleCommitReason(input: {
  sha: string;
  before?: string | null;
  applied: AppliedCommit[];
}): string | null {
  const [live] = input.applied;
  if (!live || live.sha === input.sha) return null;
  if (!input.applied.some((a) => a.sha === input.sha)) return null;
  if (input.before && input.before === live.sha) return null;
  const s = (x: string) => x.slice(0, 7);
  return `${s(input.sha)} is older than ${s(live.sha)}, which is live — a replayed push never rolls the app back. Revert in git, or deploy ${s(input.sha)} from the dashboard.`;
}

/** The environment's applied commits, newest first (a plan that ran, fully or in part). */
export async function appliedCommits(
  db: DB,
  where: { repoId: string; environment: string; prNumber: number },
): Promise<AppliedCommit[]> {
  return db.appPlan.findMany({
    where: { ...where, status: { in: ['applied', 'partial'] } },
    orderBy: { updatedAt: 'desc' },
    take: 500,
    select: { sha: true },
  });
}
