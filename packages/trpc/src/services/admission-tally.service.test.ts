import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { admissionTally, TALLY_CAP } from './admission-tally.service';

describe('admissionTally: the receipts query', () => {
  it('reads only this org’s admission rows inside the window, and counts them per rule', async () => {
    let where: Record<string, unknown> = {};
    const rows = [
      {
        action: 'guardrails.deploy.allowed',
        targetId: 'shop',
        metadata: { outcome: 'allowed', admitted: true, checks: [], wouldBlock: [{ rule: 'guardrails/require-healthcheck', level: 'off', resources: ['web'] }] },
      },
      { action: 'guardrails.deploy.blocked', targetId: 'shop', metadata: { violations: [{ rule: 'images/unsigned', severity: 'block', message: 'x' }] } },
    ];
    const ctx = {
      activeOrgId: 'o1',
      db: { auditLog: { findMany: async (args: { where: Record<string, unknown> }) => ((where = args.where), rows) } },
    } as unknown as OrgContext;
    const before = Date.now();
    const t = await admissionTally(ctx, {});
    expect(where.orgId).toBe('o1');
    expect((where.action as { in: string[] }).in).toEqual([
      'guardrails.deploy.blocked', 'guardrails.deploy.warned', 'guardrails.deploy.allowed', 'stack.deploy.override', 'service.deploy.override',
    ]);
    const gte = (where.ts as { gte: Date }).gte.getTime();
    expect(before - gte).toBeGreaterThanOrEqual(30 * 86_400_000 - 1_000);
    expect(t).toMatchObject({ days: 30, capped: false, totals: { blocked: 1, allowed: 1, warned: 0, overridden: 0 } });
    expect(t.rules.map((r) => [r.rule, r.blocked, r.wouldBlock])).toEqual([
      ['guardrails/require-healthcheck', 0, 1],
      ['images/unsigned', 1, 0],
    ]);
  });

  it('a full read is flagged as a floor', async () => {
    const rows = Array.from({ length: TALLY_CAP }, () => ({ action: 'guardrails.deploy.blocked', targetId: 'shop', metadata: {} }));
    const ctx = { activeOrgId: 'o1', db: { auditLog: { findMany: async () => rows } } } as unknown as OrgContext;
    expect((await admissionTally(ctx, { days: 7 })).capped).toBe(true);
  });
});
