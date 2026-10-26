/**
 * The plan drawer's "YAML diff" (board 26): what a plan changes in
 * swarmy.yaml, and in the spec swarmy renders from it, against the release
 * that is live. Read-only, org members (the same audience as the plan and the
 * Source tab's file); the diff itself is drawn by the dashboard.
 *
 * - The base is the newest APPLIED plan of the same environment created
 *   before this one at another commit ("the release before it" once this one
 *   is live). A preview compares with the environment it previews (its data
 *   source, else production) as it runs now.
 * - The file text at each commit comes from the per-commit cache, else one
 *   inspect on a Builder (`configTextAt`, as the Source tab). With no Builder
 *   online the file tab says so and the spec diff still shows: specs are
 *   AppPlan history (`desiredJson`), no git access needed.
 * - Spec diffs are only offered within one environment: a preview's spec has
 *   its own stack, hosts and sizes, so every line would differ.
 */
import { desiredYaml, PRODUCTION, type DesiredApp } from '@swarmy/app-config';
import type { OrgContext } from '../../context';
import { notFound } from '../../errors';
import { configTextAt } from './config-file';

export interface PlanDiffBase {
  planId: string;
  sha: string;
  environment: string;
  appliedAt: string | null;
  /** `live` = the environment runs it now; `before` = an older release (this plan or a newer one replaced it). */
  relation: 'live' | 'before';
}

export interface PlanDiffView {
  planId: string;
  sha: string;
  environment: string;
  path: string;
  /** Null = nothing applied yet to compare with (a first deploy). */
  base: PlanDiffBase | null;
  /** swarmy.yaml at the base commit and at this one; null = couldn't be read (`fileError`). */
  file: { before: string | null; after: string | null } | null;
  fileError: string | null;
  /** The rendered desired spec, signatures dropped; null for a preview (see above). */
  spec: { before: string | null; after: string | null } | null;
}

export interface BaseCandidate {
  id: string;
  sha: string;
  stack: string;
  environment: string;
  appliedAt: Date | null;
  createdAt: Date;
  desiredJson: unknown;
}

type ReadText = typeof configTextAt;

/** PURE — the environment a plan is compared with. */
export function baseEnvironmentOf(row: { environment: string; desiredJson: unknown }): string {
  if (row.environment !== 'preview') return row.environment;
  return (row.desiredJson as DesiredApp | null)?.previewData?.fromEnvironment ?? PRODUCTION;
}

/** PURE — the release to diff against, from that environment's plans (newest first). */
export function pickBase(
  row: { id: string; sha: string; stack: string; environment: string; createdAt: Date },
  candidates: readonly BaseCandidate[],
): { base: BaseCandidate; relation: PlanDiffBase['relation'] } | null {
  const live = candidates.find((c) => c.appliedAt) ?? null;
  const applied = candidates.filter((c) => c.appliedAt && c.id !== row.id);
  if (row.environment === 'preview') return live ? { base: live, relation: 'live' } : null;
  const base = applied.find((c) => c.stack === row.stack && c.sha !== row.sha && c.createdAt < row.createdAt);
  if (!base) return null;
  return { base, relation: base.id === live?.id ? 'live' : 'before' };
}

export async function readPlanDiff(ctx: OrgContext, planId: string, read: ReadText = configTextAt): Promise<PlanDiffView> {
  const row = await ctx.db.appPlan.findFirst({ where: { id: planId, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('plan', planId);
  const repo = await ctx.db.gitRepo.findFirst({
    where: { id: row.repoId, orgId: ctx.activeOrgId },
    select: { id: true, branch: true, configPath: true },
  });
  if (!repo) throw notFound('repo', row.repoId);

  const baseEnv = baseEnvironmentOf(row);
  const candidates = (await ctx.db.appPlan.findMany({
    where: { orgId: ctx.activeOrgId, repoId: row.repoId, environment: baseEnv, appliedAt: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, sha: true, stack: true, environment: true, appliedAt: true, createdAt: true, desiredJson: true },
  })) as BaseCandidate[];
  const picked = pickBase(row, candidates);
  const base = picked?.base ?? null;

  let file: PlanDiffView['file'] = null;
  let fileError: string | null = null;
  try {
    const [after, before] = await Promise.all([
      read(ctx, repo, row.sha, row.environment),
      base ? read(ctx, repo, base.sha, base.environment) : Promise.resolve(null),
    ]);
    file = { before: before?.text ?? null, after: after.text };
  } catch (e) {
    fileError = `couldn't read ${repo.configPath} from git: ${e instanceof Error ? e.message : String(e)}`;
  }

  const sameEnv = row.environment !== 'preview';
  return {
    planId: row.id,
    sha: row.sha,
    environment: row.environment,
    path: repo.configPath,
    base: base
      ? { planId: base.id, sha: base.sha, environment: base.environment, appliedAt: base.appliedAt?.toISOString() ?? null, relation: picked!.relation }
      : null,
    file,
    fileError,
    spec: sameEnv
      ? { before: desiredYaml(base?.desiredJson as DesiredApp | null), after: desiredYaml(row.desiredJson as DesiredApp | null) }
      : null,
  };
}
