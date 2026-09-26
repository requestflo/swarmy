import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { deliverSummary, getBudget, runWeeklySummary, setBudget } from './cost-budget.service';

/**
 * Owner decision Q6 against a real store: the budget row, the warn-at % living
 * on the cost-budget alert rule, the plain summary delivery and the weekly
 * send's once-per-slot claim (clock injected).
 */
process.env.SWARMY_SECRET_KEY ??= 'a'.repeat(64);

let t: TestDb;
let seq = 0;
const bodies: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  t = await createTestDb();
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ''));
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await t?.close();
});
afterEach(() => {
  bodies.length = 0;
});

/** A fresh org with servers priced at `prices` (the swarmy.node.cost label via the hub). */
async function org(prices: number[] = []): Promise<OrgContext> {
  const id = `org_b${++seq}`;
  await t.db.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
  const labels = new Map<string, Record<string, string>>();
  for (const [i, p] of prices.entries()) {
    const n = await t.db.node.create({ data: { orgId: id, name: `n${i}`, hostname: `n${i}` } });
    labels.set(n.id, { 'swarmy.node.cost': String(p) });
  }
  const hub = { nodeInfoFor: (nodeId: string) => (labels.has(nodeId) ? { labels: labels.get(nodeId) } : undefined) };
  return { db: t.db, hub, activeOrgId: id, user: null } as unknown as OrgContext;
}

const base = { warnAtPct: 80, weeklySummary: false, weeklyChannelIds: [] as string[] };

describe('getBudget / setBudget', () => {
  it('has no budget and no status until one is set; the rule defaults to 80%', async () => {
    const ctx = await org([192, 22]);
    const b = await getBudget(ctx);
    expect(b).toMatchObject({ monthlyUsd: null, warnAtPct: 80, status: null, weeklySummary: false, timeZone: 'UTC' });
    expect(b.ruleId).toBeTruthy();
  });

  it('stores the budget and puts the warn-at % and channels on the cost-budget rule', async () => {
    const ctx = await org([192, 22]);
    const b = await setBudget(ctx, { ...base, monthlyUsd: 300, warnAtPct: 90, warnChannelIds: ['ch1'] });
    expect(b.status).toEqual({ budgetUsd: 300, projectedUsd: 214, usedPct: 71, warnPct: 90, state: 'ok' });
    const rule = await t.db.alertRule.findFirst({ where: { orgId: ctx.activeOrgId, signal: 'cost-budget', isDefault: true } });
    expect(rule?.threshold).toBe(90);
    expect(rule?.channelIds).toEqual(['ch1']);
    const audit = await t.db.auditLog.findFirst({ where: { orgId: ctx.activeOrgId, action: 'cost.budget.set' } });
    expect(audit).toBeTruthy();
  });

  it('reads warn once the projected month reaches the warn %', async () => {
    const ctx = await org([250]);
    const b = await setBudget(ctx, { ...base, monthlyUsd: 300 });
    expect(b.status?.state).toBe('warn');
  });

  it('uses the quiet-hours zone for the weekly send', async () => {
    const ctx = await org();
    await t.db.alertQuietHours.create({ data: { orgId: ctx.activeOrgId, timeZone: 'Europe/London' } });
    expect((await getBudget(ctx)).timeZone).toBe('Europe/London');
  });
});

describe('deliverSummary', () => {
  it('sends one plain message to the chosen channels only', async () => {
    const ctx = await org();
    const mk = async (name: string): Promise<string> =>
      (
        await t.db.notificationChannel.create({
          data: { orgId: ctx.activeOrgId, name, kind: 'SLACK', configEnc: encryptSecret(JSON.stringify({ kind: 'slack', url: `https://hooks.test/${name}` })) },
        })
      ).id;
    const ops = await mk('ops');
    await mk('other');
    const r = await deliverSummary(ctx, [ops], '$214 of $300 this month (71%).');
    expect(r).toEqual({ sent: 1, failed: 0 });
    expect(bodies).toEqual([JSON.stringify({ text: 'Weekly cost summary: $214 of $300 this month (71%).' })]);
  });
});

describe('runWeeklySummary — once per Monday 09:00 slot', () => {
  const send = (calls: string[]) => async (ctx: OrgContext) => {
    calls.push(ctx.activeOrgId);
    return { text: 'x', sent: 1, failed: 0 };
  };

  it('is off until the summary is switched on', async () => {
    const ctx = await org();
    const calls: string[] = [];
    expect(await runWeeklySummary(ctx, new Date('2026-09-28T09:05:00Z'), send(calls))).toBe('off');
    expect(calls).toEqual([]);
  });

  it('sends once at the slot, never twice, and again next Monday', async () => {
    const ctx = await org();
    await setBudget(ctx, { ...base, monthlyUsd: 300, weeklySummary: true });
    const calls: string[] = [];
    expect(await runWeeklySummary(ctx, new Date('2026-09-28T08:55:00Z'), send(calls))).toBe('not-due');
    expect(await runWeeklySummary(ctx, new Date('2026-09-28T09:00:30Z'), send(calls))).toBe('sent');
    expect(await runWeeklySummary(ctx, new Date('2026-09-28T09:01:00Z'), send(calls))).toBe('not-due');
    expect(await runWeeklySummary(ctx, new Date('2026-10-01T09:01:00Z'), send(calls))).toBe('not-due');
    expect(await runWeeklySummary(ctx, new Date('2026-10-05T09:00:10Z'), send(calls))).toBe('sent');
    expect(calls).toHaveLength(2);
    const row = await t.db.costBudget.findUnique({ where: { orgId: ctx.activeOrgId } });
    expect(row?.lastWeeklyAt?.toISOString()).toBe('2026-10-05T09:00:10.000Z');
  });

  it('two overlapping ticks claim the slot once', async () => {
    const ctx = await org();
    await setBudget(ctx, { ...base, monthlyUsd: null, weeklySummary: true });
    const calls: string[] = [];
    const now = new Date('2026-09-28T09:02:00Z');
    const results = await Promise.all([runWeeklySummary(ctx, now, send(calls)), runWeeklySummary(ctx, now, send(calls))]);
    expect(results.filter((r) => r === 'sent')).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});
