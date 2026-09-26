import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import { runWeeklySummary, type OrgContext } from '@swarmy/trpc';
import { weeklySummaryTick, type WeeklyTickDeps } from './cost-weekly-summary';

/** The weekly cost summary worker: once per Monday 09:00 slot per org, clock injected. */
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});

describe('weeklySummaryTick', () => {
  it('sends once per org per Monday slot, in each org’s own zone', async () => {
    for (const id of ['utc', 'ldn', 'off']) {
      await t.db.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
    }
    await t.db.costBudget.create({ data: { orgId: 'utc', monthlyUsd: 300, weeklySummary: true } });
    await t.db.costBudget.create({ data: { orgId: 'ldn', monthlyUsd: null, weeklySummary: true } });
    await t.db.costBudget.create({ data: { orgId: 'off', monthlyUsd: 300, weeklySummary: false } });
    await t.db.alertQuietHours.create({ data: { orgId: 'ldn', timeZone: 'Europe/London' } });

    const sent: string[] = [];
    const deps: WeeklyTickDeps = {
      orgIds: async () => (await t.db.costBudget.findMany({ where: { weeklySummary: true } })).map((r) => r.orgId),
      context: (orgId) => ({ db: t.db, hub: {}, activeOrgId: orgId, user: null }) as unknown as OrgContext,
      run: (ctx, now) =>
        runWeeklySummary(ctx, now, async (c) => {
          sent.push(`${c.activeOrgId}@${now.toISOString()}`);
          return { text: 'x', sent: 1, failed: 0 };
        }),
    };

    // Monday 08:30Z: 09:30 in London (due), 08:30 in UTC (not yet).
    expect(await weeklySummaryTick(new Date('2026-09-28T08:30:00Z'), deps)).toEqual({ utc: 'not-due', ldn: 'sent' });
    expect(await weeklySummaryTick(new Date('2026-09-28T09:00:00Z'), deps)).toEqual({ utc: 'sent', ldn: 'not-due' });
    // Every later tick that week is quiet.
    expect(await weeklySummaryTick(new Date('2026-09-28T09:10:00Z'), deps)).toEqual({ utc: 'not-due', ldn: 'not-due' });
    expect(await weeklySummaryTick(new Date('2026-10-02T09:00:00Z'), deps)).toEqual({ utc: 'not-due', ldn: 'not-due' });
    // The next Monday sends again.
    expect(await weeklySummaryTick(new Date('2026-10-05T09:00:00Z'), deps)).toEqual({ utc: 'sent', ldn: 'sent' });
    expect(sent).toEqual([
      'ldn@2026-09-28T08:30:00.000Z',
      'utc@2026-09-28T09:00:00.000Z',
      'utc@2026-10-05T09:00:00.000Z',
      'ldn@2026-10-05T09:00:00.000Z',
    ]);
  });

  it('one org failing never stops the others', async () => {
    const deps: WeeklyTickDeps = {
      orgIds: async () => ['a', 'b'],
      context: (orgId) => ({ activeOrgId: orgId }) as unknown as OrgContext,
      run: async (ctx) => {
        if (ctx.activeOrgId === 'a') throw new Error('boom');
        return 'sent';
      },
    };
    expect(await weeklySummaryTick(new Date(), deps)).toEqual({ a: 'error', b: 'sent' });
  });
});
