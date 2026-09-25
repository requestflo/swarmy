import { describe, expect, it } from 'bun:test';
import { retryablePlanStatus, retryPlan } from './apps.service';

/** QA-030: a failed plan for a sha can be re-run; nothing else can. */
function ctxWith(plan: Record<string, unknown> | null) {
  return {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    db: {
      appPlan: { findFirst: async () => plan },
      gitRepo: { findFirst: async () => null },
    },
  } as never;
}

describe('retry a failed plan', () => {
  it('only failed / partial plans are retryable', () => {
    expect(retryablePlanStatus('failed')).toBe(true);
    expect(retryablePlanStatus('partial')).toBe(true);
    for (const s of ['planned', 'applying', 'applied', 'needs-confirmation', 'blocked', 'superseded', 'invalid']) {
      expect(retryablePlanStatus(s)).toBe(false);
    }
  });

  it('refuses a plan that is not failed', async () => {
    await expect(retryPlan(ctxWith({ id: 'p1', status: 'applied', repoId: 'r1' }), { planId: 'p1' })).rejects.toThrow(
      /only a failed plan can be retried/,
    );
  });

  it('an unknown plan is not found', async () => {
    await expect(retryPlan(ctxWith(null), { planId: 'nope' })).rejects.toThrow(/plan/);
  });

  it('a failed plan proceeds to re-plan its repo (repo lookup is the next step)', async () => {
    await expect(retryPlan(ctxWith({ id: 'p1', status: 'failed', repoId: 'r1', sha: 'abc', trigger: 'push' }), { planId: 'p1' })).rejects.toThrow(
      /repo/,
    );
  });
});

describe('retry scope', () => {
  it('a promote plan is re-run by promoting again, not here', async () => {
    await expect(
      retryPlan(ctxWith({ id: 'p1', status: 'failed', repoId: 'r1', sha: 'abc', trigger: 'promote' }), { planId: 'p1' }),
    ).rejects.toThrow(/promote plan can't be retried/);
  });
});
