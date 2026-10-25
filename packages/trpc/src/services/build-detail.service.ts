/**
 * One build for its page: the build, its timed stages, what each stage
 * "usually" takes for this repo (median of the newest successful builds),
 * and its release version when the tag or its Release names one.
 * Org-scoped; history only.
 */
import { buildVersion } from '@swarmy/core';
import type { BuildStageKey } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { toBuildView, type BuildView } from './cicd.service';
import { USUAL_SAMPLE, usualStageMs } from './build-stages';

export interface BuildDetailView extends BuildView {
  /** Median ms per stage over the repo's newest successful builds (absent = no sample). */
  usualMs: Partial<Record<BuildStageKey, number>>;
  /** "v1.4.0" when the tag, image or recorded Release says one; null = show the short commit. */
  version: string | null;
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
  const release = row.releaseId
    ? await ctx.db.release.findFirst({ where: { id: row.releaseId, orgId: ctx.activeOrgId }, select: { imagesJson: true } })
    : null;
  const releaseImages = Array.isArray(release?.imagesJson)
    ? (release.imagesJson as unknown[]).filter((i): i is { image: string } => typeof (i as { image?: unknown })?.image === 'string')
    : [];
  const version = buildVersion({ commit: row.commit, image: row.image, releaseImages });
  return { ...toBuildView(row, ''), usualMs: usualStageMs(history), version };
}
