import { describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { defaultPolicyInputs } from '@swarmy/abac';
import type { OrgContext } from '../context';
import { applyPolicyChange, ownersCanManagePolicies } from './policy-lockout';
import { deletePolicy, setPolicy } from './policies.service';
import type { PolicyRecord } from './policy-repo';

const OWNER_RULE = 'Owners can do anything';
const defaults = (): PolicyRecord[] =>
  defaultPolicyInputs().map((p, i) => ({
    id: `d${i}`, name: p.name, description: null, effect: p.effect, source: p.source,
    priority: p.priority, enabled: true, isDefault: true, updatedAt: new Date(0),
  }));
const custom = (id: string, effect: 'permit' | 'forbid', doc: object): PolicyRecord => ({
  id, name: id, description: null, effect, source: JSON.stringify(doc), priority: 10, enabled: true, isDefault: false,
  updatedAt: new Date(0),
});
const OWNERS = [
  { id: 'm-a', userId: 'u-a', role: 'owner', attributes: {} },
  { id: 'm-b', userId: 'u-b', role: 'owner', attributes: {} },
];
const can = (rows: PolicyRecord[], owners = OWNERS) => ownersCanManagePolicies('org1', owners, rows);
const ownerRuleOff = () => defaults().map((r) => (r.name === OWNER_RULE ? { ...r, enabled: false } : r));

describe('owners keep policy.write (security review M5)', () => {
  it('holds under the defaults and with no rows at all', async () => {
    expect(await can(defaults())).toBe(true);
    expect(await can([])).toBe(true);
  });

  it('fails when "Owners can do anything" is off, or a forbid covers owners', async () => {
    expect(await can(ownerRuleOff())).toBe(false);
    expect(await can([...defaults(), custom('no-owners', 'forbid', { roles: ['owner'], actions: ['policy.write'] })])).toBe(false);
    expect(await can([...defaults(), custom('freeze', 'forbid', { actions: ['*'] })])).toBe(false);
  });

  it('holds while one owner is spared, or another rule lets owners manage rules', async () => {
    expect(await can([...defaults(), custom('not-a', 'forbid', { members: ['u-a'], actions: ['policy.write'] })])).toBe(true);
    expect(await can([...ownerRuleOff(), custom('owners-rules', 'permit', { roles: ['owner'], actions: ['policy.write'] })])).toBe(true);
  });

  it('applyPolicyChange updates in place, appends, and deletes', () => {
    const rows = defaults();
    const off = applyPolicyChange(rows, { kind: 'upsert', write: { id: 'd0', name: rows[0]!.name, effect: 'permit', source: rows[0]!.source, enabled: false } });
    expect(off[0]).toMatchObject({ id: 'd0', enabled: false, isDefault: true, priority: rows[0]!.priority });
    expect(applyPolicyChange(rows, { kind: 'upsert', write: { name: 'x', effect: 'forbid', source: '{}' } })).toHaveLength(rows.length + 1);
    expect(applyPolicyChange(rows, { kind: 'delete', id: 'd0' }).some((r) => r.id === 'd0')).toBe(false);
  });
});

function ctxWith(rows: PolicyRecord[], writes: string[]): OrgContext {
  const raw = rows.map((r) => ({ ...r, isdefault: r.isDefault }));
  return {
    db: {
      member: { findMany: async () => [OWNERS[0]] },
      policy: {
        findMany: async () => raw,
        findFirst: async ({ where }: { where: { id: string } }) => raw.find((r) => r.id === where.id) ?? null,
        update: async () => { writes.push('update'); return raw[0]; },
        create: async () => { writes.push('create'); return raw[0]; },
        deleteMany: async () => { writes.push('delete'); return { count: 1 }; },
      },
      auditLog: { create: async () => ({}) },
    },
    activeOrgId: 'org1',
    user: { id: 'u-admin' },
    membership: { role: 'admin', orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
}

const isLockout = (e: unknown) =>
  e instanceof TRPCError && (e.cause as { swarmyCode?: string } | undefined)?.swarmyCode === 'POLICY_LOCKOUT';

describe('policies.set / delete refuse an owner lockout and write nothing', () => {
  it('switching "Owners can do anything" off is refused', async () => {
    const writes: string[] = [];
    const owner = defaults().find((r) => r.name === OWNER_RULE)!;
    const toggle = { id: owner.id, name: owner.name, effect: owner.effect, source: owner.source, enabled: false };
    const e = await setPolicy(ctxWith(defaults(), writes), toggle).catch((x: unknown) => x);
    expect(isLockout(e)).toBe(true);
    expect(writes).toEqual([]);
  });

  it('a forbid on owners is refused; an unrelated rule is saved', async () => {
    const writes: string[] = [];
    const ctx = ctxWith(defaults(), writes);
    const forbid = { name: 'no owners', effect: 'forbid' as const, source: JSON.stringify({ roles: ['owner'], actions: ['*'] }) };
    expect(isLockout(await setPolicy(ctx, forbid).catch((x: unknown) => x))).toBe(true);
    await setPolicy(ctx, { name: 'no prod deploys', effect: 'forbid', source: JSON.stringify({ roles: ['member'], actions: ['stack.deploy'] }) });
    expect(writes).toEqual(['create']);
  });

  it('deleting the only rule that lets owners manage rules is refused', async () => {
    const writes: string[] = [];
    const rows = [...ownerRuleOff(), custom('owners-rules', 'permit', { roles: ['owner'], actions: ['policy.write'] })];
    expect(isLockout(await deletePolicy(ctxWith(rows, writes), 'owners-rules').catch((x: unknown) => x))).toBe(true);
    expect(writes).toEqual([]);
  });
});
