/**
 * `rum.funnel` — one funnel's visitors per step, conversion, the biggest drop
 * and, when the numbers support it, the release since which it got worse.
 * Read-only and org-scoped: the SQL is the pure `buildFunnelQuery` (org + app
 * wall); release boundaries are this org's own `Release` rows for the stack.
 *
 * RUM rows carry no release or commit tag, so a visit belongs to the release
 * that was live when it began (deploy time). A canary shares traffic with the
 * stable copy, so "since vN" means "since vN went out", not "on vN".
 */
import {
  biggestDrop,
  buildFunnelQuery,
  dropSince,
  funnelStepName,
  releaseSplits,
  stepCounts,
  stepVisitors,
  type FunnelReleaseBoundary,
  type FunnelRow,
} from '@swarmy/rum';
import type { OrgContext } from '../../context';
import { appRumFunnels } from './rum-funnels.service';
import { appRumSettings } from './rum-settings.service';
import { rumClickhouse } from './rum-store';
import type { RumStatus } from './rum-query';

export interface FunnelReleaseRef {
  releaseId: string;
  /** First image ref of that release (the dashboard labels it "v1.9.0"); null for '' (before any known release). */
  image: string | null;
  at: string | null;
}

export interface FunnelView {
  status: RumStatus | 'no-funnel';
  days: number;
  funnel: { id: string; name: string; windowMinutes: number } | null;
  /** What a number counts: visits, or signed-in people (identified mode only). */
  audience: 'visits' | 'signed-in';
  steps: Array<{ name: string; path: string; event: string | null; visitors: number; conversion: number; dropOff: number }>;
  biggestDrop: { index: number; from: string; to: string; dropOff: number; lost: number } | null;
  since: (FunnelReleaseRef & { before: number; after: number }) | null;
  /** The biggest drop's two steps per release, newest first. */
  releases: Array<FunnelReleaseRef & { entered: number; reached: number; converted: number }>;
}

interface ReleaseRow {
  id: string;
  createdAt: Date;
  imagesJson: unknown;
}

function firstImage(imagesJson: unknown): string | null {
  const first = Array.isArray(imagesJson) ? (imagesJson[0] as { image?: unknown } | undefined) : undefined;
  return typeof first?.image === 'string' ? first.image : null;
}

/** The stack's releases inside the window, plus the one already live when it opened. */
async function stackReleases(ctx: OrgContext, stack: string, days: number): Promise<ReleaseRow[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const select = { id: true, createdAt: true, imagesJson: true } as const;
  const [inside, before] = await Promise.all([
    ctx.db.release.findMany({ where: { orgId: ctx.activeOrgId, stackName: stack, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 11, select }),
    ctx.db.release.findFirst({ where: { orgId: ctx.activeOrgId, stackName: stack, createdAt: { lt: since } }, orderBy: { createdAt: 'desc' }, select }),
  ]);
  return before ? [...inside, before] : inside;
}

export async function funnel(
  ctx: OrgContext,
  input: { stack: string; funnel: string; days?: number; signedIn?: boolean },
): Promise<FunnelView> {
  const days = Math.min(90, Math.max(1, Math.floor(input.days ?? 7)));
  const signedIn = input.signedIn === true && appRumSettings(ctx, input.stack).mode === 'identified';
  const f = appRumFunnels(ctx, input.stack).find((x) => x.id === input.funnel);
  const steps = (f?.steps ?? []).map((s) => ({ name: funnelStepName(s), path: s.path, event: s.event ?? null }));
  const empty: FunnelView = {
    status: 'no-funnel',
    days,
    funnel: f ? { id: f.id, name: f.name, windowMinutes: f.windowMinutes } : null,
    audience: signedIn ? 'signed-in' : 'visits',
    steps: steps.map((s) => ({ ...s, visitors: 0, conversion: 0, dropOff: 0 })),
    biggestDrop: null,
    since: null,
    releases: [],
  };
  if (!f) return empty;
  const client = await rumClickhouse(ctx, ctx.activeOrgId).catch(() => null);
  if (!client) return { ...empty, status: 'disabled' };
  const releases = await stackReleases(ctx, input.stack, days);
  const boundaries: FunnelReleaseBoundary[] = releases.map((r) => ({ id: r.id, fromMs: r.createdAt.getTime() }));
  let rows: FunnelRow[];
  try {
    rows = await client.json<FunnelRow>(
      buildFunnelQuery(ctx.activeOrgId, input.stack, { steps: f.steps, days, windowMinutes: f.windowMinutes, signedIn, releases: boundaries }),
    );
  } catch {
    return { ...empty, status: 'unreachable' };
  }
  const counts = stepCounts(stepVisitors(rows, steps.length));
  const drop = biggestDrop(counts.map((c) => c.visitors));
  const ref = (id: string): FunnelReleaseRef => {
    const r = releases.find((x) => x.id === id);
    return { releaseId: id, image: r ? firstImage(r.imagesJson) : null, at: r ? r.createdAt.toISOString() : null };
  };
  const splits = drop ? releaseSplits(rows, steps.length, drop) : [];
  const since = drop ? dropSince(splits, boundaries) : null;
  const order = (id: string) => (id ? releases.findIndex((r) => r.id === id) : releases.length);
  return {
    ...empty,
    status: 'ok',
    steps: steps.map((s, i) => ({ ...s, ...counts[i]! })),
    biggestDrop: drop ? { ...drop, from: steps[drop.index - 1]!.name, to: steps[drop.index]!.name } : null,
    since: since ? { ...ref(since.releaseId), before: since.before, after: since.after } : null,
    releases: splits
      .sort((a, b) => order(a.releaseId) - order(b.releaseId))
      .map((s) => ({ ...ref(s.releaseId), entered: s.entered, reached: s.reached, converted: s.converted })),
  };
}
