/**
 * One build for its page: the build, its timed stages, and what each stage
 * "usually" takes for this repo (median of the newest successful builds).
 * Org-scoped; history only.
 */
import type { BuildStageKey } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { toBuildView, type BuildView } from './cicd.service';
import { USUAL_SAMPLE, usualStageMs } from './build-stages';

export interface BuildDetailView extends BuildView {
  /** Median ms per stage over the repo's newest successful builds (absent = no sample). */
  usualMs: Partial<Record<BuildStageKey, number>>;
}

export async function getBuild(ctx: OrgContext, buildId: string): Promise<BuildDetailView> {
  const row = await ctx.db.build.findFirst({
    where: { id: buildId, orgId: ctx.activeOrgId },
    include: { repo: { select: { url: true } }, stages: true },
  });
  if (!row) throw notFound('build', buildId);
  const history = await ctx.db.build.findMany({
    where: { orgId: ctx.activeOrgId, repoId: row.repoId, status: 'SUCCEEDED', id: { not: row.id } },
    orderBy: { startedAt: 'desc' },
    take: USUAL_SAMPLE,
    select: { status: true, startedAt: true, stages: true },
  });
  return { ...toBuildView(row, ''), usualMs: usualStageMs(history) };
}
