import { describe, expect, it } from 'bun:test';
import { ORPHANED_PLAN_REASON, reconcileOrphanedWork } from './build-orphans.service';
import { retryablePlanStatus } from './apps.service';

/** Section-2: builds / plans left in flight by the previous controller process. */
function fakeDb() {
  const boot = new Date('2026-09-25T12:00:00Z');
  const before = new Date('2026-09-25T11:50:00Z');
  const after = new Date('2026-09-25T12:01:00Z');
  const builds = [
    { id: 'b-old', orgId: 'o', status: 'BUILDING', createdAt: before, logsRef: 'b-old', finishedAt: null as Date | null },
    { id: 'b-new', orgId: 'o', status: 'BUILDING', createdAt: after, logsRef: null, finishedAt: null as Date | null },
    { id: 'b-done', orgId: 'o', status: 'SUCCEEDED', createdAt: before, logsRef: null, finishedAt: before },
  ];
  const plans = [
    { id: 'p-old', orgId: 'o', status: 'applying', updatedAt: before, error: null as string | null },
    { id: 'p-new', orgId: 'o', status: 'applying', updatedAt: after, error: null as string | null },
  ];
  const audits: string[] = [];
  const db = {
    build: {
      findMany: async ({ where }: any) =>
        builds.filter((b) => where.status.in.includes(b.status) && b.createdAt < where.createdAt.lt),
      update: async ({ where, data }: any) => Object.assign(builds.find((b) => b.id === where.id)!, data),
    },
    appPlan: {
      findMany: async ({ where }: any) => plans.filter((p) => p.status === where.status && p.updatedAt < where.updatedAt.lt),
      update: async ({ where, data }: any) => Object.assign(plans.find((p) => p.id === where.id)!, data),
    },
    auditLog: { create: async ({ data }: any) => audits.push(data.action) },
  };
  return { db: db as never, boot, builds, plans, audits };
}

describe('reconcileOrphanedWork', () => {
  it('fails only what the previous process left in flight, with a reason; the plan becomes retryable', async () => {
    const f = fakeDb();
    const r = await reconcileOrphanedWork(f.db, f.boot);
    expect(r).toEqual({ builds: ['b-old'], plans: ['p-old'] });
    expect(f.builds.find((b) => b.id === 'b-old')!.status).toBe('FAILED');
    expect(f.builds.find((b) => b.id === 'b-old')!.finishedAt).not.toBeNull();
    expect(f.builds.find((b) => b.id === 'b-new')!.status).toBe('BUILDING');
    const p = f.plans.find((x) => x.id === 'p-old')!;
    expect(p).toMatchObject({ status: 'failed', error: ORPHANED_PLAN_REASON });
    expect(retryablePlanStatus(p.status)).toBe(true);
    expect(f.plans.find((x) => x.id === 'p-new')!.status).toBe('applying');
    expect(f.audits).toEqual(['cicd.build.orphaned', 'app.plan.orphaned']);
  });
});
