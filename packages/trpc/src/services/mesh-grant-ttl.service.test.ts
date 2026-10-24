import { describe, expect, it } from 'bun:test';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import { orgsWithExpiredGrants, sweepExpiredPersonGrants } from './mesh-grant-ttl.service';
import { revokePersonGrant } from './mesh-people.service';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

interface Row {
  id: string;
  orgId: string;
  kind: string;
  principalId: string;
  targetStackId: string | null;
  expiresAt: Date | null;
}

const row = (id: string, orgId: string, expiresAt: Date | null, kind = 'person'): Row => ({
  id,
  orgId,
  kind,
  principalId: `u-${id}`,
  targetStackId: 'st-shop',
  expiresAt,
});

/** In-memory MeshRoute + AuditLog, just the calls the sweeper and the revoke path make. */
function fake(rows: Row[], opts: { vanish?: string[] } = {}) {
  const audits: Record<string, unknown>[] = [];
  const due = (r: Row, lte: Date) => r.kind === 'person' && r.expiresAt !== null && r.expiresAt <= lte;
  const db = {
    meshRoute: {
      findMany: async ({ where }: { where: { orgId?: string; expiresAt: { lte: Date } } }) =>
        rows.filter((r) => (!where.orgId || r.orgId === where.orgId) && due(r, where.expiresAt.lte)),
      findFirst: async ({ where }: { where: { id: string; orgId: string; kind: string } }) =>
        opts.vanish?.includes(where.id) ? null : (rows.find((r) => r.id === where.id && r.orgId === where.orgId && r.kind === where.kind) ?? null),
      delete: async ({ where }: { where: { id: string } }) => rows.splice(rows.findIndex((r) => r.id === where.id), 1)[0],
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => void audits.push(data) },
  };
  const ctx = (orgId: string) => ({ db, activeOrgId: orgId, user: null }) as unknown as OrgContext;
  return { db: db as unknown as DB, ctx, audits, rows };
}

describe('personal grant TTL sweeper (revokes through the revoke path, as the system actor)', () => {
  it('revokes only expired grants of this org, audits each as system/expired, converges once', async () => {
    const f = fake([
      row('g-old', 'org-a', ago(60)),
      row('g-now', 'org-a', NOW),
      row('g-later', 'org-a', ago(-30)),
      row('g-forever', 'org-a', null),
      row('g-other-org', 'org-b', ago(60)),
      row('g-legacy', 'org-a', ago(60), 'direct'),
    ]);
    let converges = 0;
    const r = await sweepExpiredPersonGrants(f.ctx('org-a'), { now: NOW, converge: async () => (converges++, true) });
    expect(r).toEqual({ revoked: ['g-old', 'g-now'], skipped: [], converged: true });
    expect(converges).toBe(1);
    expect(f.rows.map((x) => x.id).sort()).toEqual(['g-forever', 'g-later', 'g-legacy', 'g-other-org']);
    expect(f.audits).toEqual([
      {
        orgId: 'org-a',
        actorType: 'system',
        actorId: null,
        action: 'mesh.access.revoke',
        targetType: 'meshRoute',
        targetId: 'g-old',
        metadata: { userId: 'u-g-old', stack: 'st-shop', reason: 'expired', expiresAt: ago(60).toISOString() },
      },
      {
        orgId: 'org-a',
        actorType: 'system',
        actorId: null,
        action: 'mesh.access.revoke',
        targetType: 'meshRoute',
        targetId: 'g-now',
        metadata: { userId: 'u-g-now', stack: 'st-shop', reason: 'expired', expiresAt: NOW.toISOString() },
      },
    ]);
  });

  it('steady state: nothing expired → no writes, no converge', async () => {
    const f = fake([row('g-later', 'org-a', ago(-5)), row('g-forever', 'org-a', null)]);
    let converges = 0;
    const r = await sweepExpiredPersonGrants(f.ctx('org-a'), { now: NOW, converge: async () => (converges++, true) });
    expect(r).toEqual({ revoked: [], skipped: [], converged: false });
    expect(converges).toBe(0);
    expect(f.audits).toEqual([]);
  });

  it('a grant someone revoked a moment earlier is skipped; the rest still go', async () => {
    const f = fake([row('g-1', 'org-a', ago(10)), row('g-2', 'org-a', ago(5))], { vanish: ['g-1'] });
    const r = await sweepExpiredPersonGrants(f.ctx('org-a'), { now: NOW, converge: async () => false });
    expect(r).toEqual({ revoked: ['g-2'], skipped: ['g-1'], converged: false });
    expect(f.audits.map((a) => a.targetId)).toEqual(['g-2']);
  });

  it('a failed converge keeps the revocations (the next people tick converges)', async () => {
    const f = fake([row('g-1', 'org-a', ago(10))]);
    const r = await sweepExpiredPersonGrants(f.ctx('org-a'), {
      now: NOW,
      converge: async () => {
        throw new Error('control plane down');
      },
    });
    expect(r).toEqual({ revoked: ['g-1'], skipped: [], converged: false });
    expect(f.rows).toEqual([]);
  });

  it('the worker visits each org with an expired grant once, sorted', async () => {
    const f = fake([row('a1', 'org-b', ago(1)), row('a2', 'org-b', ago(2)), row('a3', 'org-a', ago(3)), row('a4', 'org-c', ago(-3))]);
    expect(await orgsWithExpiredGrants(f.db, NOW)).toEqual(['org-a', 'org-b']);
  });
});

describe('revokePersonGrant (the human path is unchanged)', () => {
  it('a person revoking is audited with the default (user) actor and no reason', async () => {
    const f = fake([row('g-1', 'org-a', null)]);
    await revokePersonGrant(f.ctx('org-a'), 'g-1', { converge: false });
    expect(f.audits).toEqual([
      {
        orgId: 'org-a',
        actorType: 'user',
        actorId: null,
        action: 'mesh.access.revoke',
        targetType: 'meshRoute',
        targetId: 'g-1',
        metadata: { userId: 'u-g-1', stack: 'st-shop' },
      },
    ]);
  });
});
