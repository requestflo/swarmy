import { describe, expect, it } from 'bun:test';
import type { DashboardEnvMarker } from '@swarmy/app-config';
import type { OrgContext } from '../../context';
import type { PlanCommitInput, PlanCommitResult } from '../apps.service';
import { alreadyAtHead, planDashboardPush } from './dashboard-push';

const marker = (branch: string): { dashboard: DashboardEnvMarker } => ({ dashboard: { branch, from: 'production', secretSlots: [] } });
type Row = { repoId: string; environment: string; stack: string; prNumber: number; sha: string; createdAt: string; desiredJson: unknown };
const row = (environment: string, sha: string, createdAt: string, desiredJson: unknown = {}): Row => ({
  repoId: 'r1', environment, stack: environment === 'production' ? 'shop' : `shop-${environment}`, prNumber: 0, sha, createdAt, desiredJson,
});

/** AppPlan rows (newest first, as the queries order them). */
function ctxWith(rows: Row[]): OrgContext {
  const sorted = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const match = (r: Row, w: Record<string, unknown>) =>
    r.repoId === w.repoId && r.prNumber === w.prNumber && (w.environment === undefined || r.environment === w.environment) &&
    !((w.NOT as { environment?: { in: string[] } } | undefined)?.environment?.in.includes(r.environment));
  return {
    activeOrgId: 'org1',
    db: {
      appPlan: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => sorted.find((r) => match(r, where)) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) => sorted.filter((r) => match(r, where)),
      },
    },
  } as unknown as OrgContext;
}

const OLD = 'a'.repeat(40);
const LIVE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const recorder = (seen: PlanCommitInput[], fail?: string) => async (_c: OrgContext, i: PlanCommitInput): Promise<PlanCommitResult> => {
  seen.push(i);
  if (i.environment === fail) throw new Error('builder offline');
  return { planId: `p-${i.environment}`, status: 'applied', environment: i.environment ?? null, stack: `shop-${i.environment}` };
};

describe('planDashboardPush — a push redeploys the clones tracking its branch', () => {
  const world = () =>
    ctxWith([
      row('production', LIVE, '2026-10-20'),
      row('qa', LIVE, '2026-10-21', marker('main')),
      row('demo', LIVE, '2026-10-21', marker('main')),
      row('feat', LIVE, '2026-10-21', marker('feature-x')),
    ]);

  it('plans every clone on the pushed branch as a push (stale rule: trigger push + before), none elsewhere', async () => {
    const seen: PlanCommitInput[] = [];
    const res = await planDashboardPush(world(), { repoId: 'r1', ref: 'main', sha: HEAD, before: LIVE }, recorder(seen));
    expect(res.tracked.sort()).toEqual(['demo', 'qa']);
    expect(seen.map((i) => i.environment).sort()).toEqual(['demo', 'qa']);
    expect(seen[0]).toEqual({ repoId: 'r1', ref: 'main', sha: HEAD, trigger: 'push', environment: seen[0]!.environment, before: LIVE });
    // production is the file's: the webhook plans it on its own path.
    expect(seen.some((i) => i.environment === 'production')).toBe(false);
  });

  it('is deduped against the poll: a head the clone already planned is not planned again', async () => {
    const ctx = ctxWith([row('qa', LIVE, '2026-10-21', marker('main')), row('qa', HEAD, '2026-10-22', marker('main'))]);
    const seen: PlanCommitInput[] = [];
    const res = await planDashboardPush(ctx, { repoId: 'r1', ref: 'main', sha: HEAD, before: LIVE }, recorder(seen));
    expect(seen).toEqual([]);
    expect(res.results).toEqual([{ planId: null, status: 'skipped', environment: 'qa', stack: 'shop-qa', reason: 'already planned' }]);
  });

  it('an older commit is not deduped away: planCommit’s stale rule decides (replay refused, force-push back honoured)', async () => {
    const ctx = ctxWith([row('qa', OLD, '2026-10-20', marker('main')), row('qa', LIVE, '2026-10-21', marker('main'))]);
    const seen: PlanCommitInput[] = [];
    await planDashboardPush(ctx, { repoId: 'r1', ref: 'main', sha: OLD, before: LIVE }, recorder(seen));
    expect(seen.map((i) => [i.environment, i.sha, i.trigger, i.before])).toEqual([['qa', OLD, 'push', LIVE]]);
  });

  it('one clone failing never stops the next', async () => {
    const seen: PlanCommitInput[] = [];
    const res = await planDashboardPush(world(), { repoId: 'r1', ref: 'main', sha: HEAD, before: null }, recorder(seen, 'demo'));
    expect(seen).toHaveLength(2);
    expect(res.results.find((r) => r.environment === 'demo')).toMatchObject({ status: 'failed', reason: 'builder offline' });
    expect(res.results.find((r) => r.environment === 'qa')?.status).toBe('applied');
  });
});

describe('alreadyAtHead', () => {
  it('needs both shas and an exact match', () => {
    expect(alreadyAtHead(HEAD, HEAD)).toBe(true);
    expect(alreadyAtHead(LIVE, HEAD)).toBe(false);
    expect(alreadyAtHead(undefined, HEAD)).toBe(false);
    expect(alreadyAtHead(HEAD, null)).toBe(false);
  });
});
