import { describe, expect, it } from 'bun:test';
import { defaultPolicyInputs } from '@swarmy/abac';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import { effectivePolicyInputs } from './policy-effective';
import { prismaPolicyRepository, type PolicyRecord } from './policy-repo';
import { setPolicy } from './policies.service';

const shipped = defaultPolicyInputs();
const OWNER = shipped[0]!;
const rows = (): PolicyRecord[] =>
  shipped.map((p, i) => ({
    id: `d${i}`, name: p.name, description: null, effect: p.effect, source: p.source,
    priority: p.priority, enabled: true, isDefault: true, updatedAt: new Date(0),
  }));
/** "Owners can do anything", switched off, then renamed (possible before the fix). */
const renamedOff = (): PolicyRecord[] => rows().map((r, i) => (i === 0 ? { ...r, name: 'Owner override', enabled: false } : r));

describe('effectivePolicyInputs', () => {
  it('runs every shipped default with no rows, and the stored enable/disable otherwise', () => {
    expect(effectivePolicyInputs([]).map((p) => p.name)).toEqual(shipped.map((p) => p.name));
    const off = rows().map((r, i) => (i === 0 ? { ...r, enabled: false } : r));
    expect(effectivePolicyInputs(off).some((p) => p.name === OWNER.name)).toBe(false);
  });

  it('a renamed default that was switched off stays off (matched by source)', () => {
    expect(effectivePolicyInputs(renamedOff()).some((p) => p.name === OWNER.name)).toBe(false);
  });
});

describe('renaming a default no longer switches it back on (security review, low)', () => {
  it('ensureDefaults rewrites a renamed default and keeps it off', async () => {
    let stored: Array<Record<string, unknown>> = renamedOff().map((r) => ({ ...r, isdefault: true }));
    const db = {
      policy: {
        findMany: async () => stored,
        deleteMany: () => ({ kind: 'delete' }),
        createMany: ({ data }: { data: Array<Record<string, unknown>> }) => ({ kind: 'create', data }),
      },
      $transaction: async (ops: Array<{ kind: string; data?: Array<Record<string, unknown>> }>) => {
        stored = ops.find((o) => o.kind === 'create')!.data!;
      },
    } as unknown as DB;
    expect(await prismaPolicyRepository(db).ensureDefaults('org1')).toBe(true);
    expect(stored.find((r) => r.name === OWNER.name)?.enabled).toBe(false);
    expect(stored.some((r) => r.name === 'Owner override')).toBe(false);
  });

  it('policies.set refuses a new name for a default rule', async () => {
    const writes: string[] = [];
    const raw = rows().map((r) => ({ ...r, isdefault: true }));
    const ctx = {
      db: {
        policy: {
          findFirst: async ({ where }: { where: { id: string } }) => raw.find((r) => r.id === where.id) ?? null,
          update: async () => { writes.push('update'); return raw[0]; },
        },
      },
      activeOrgId: 'org1',
      user: { id: 'u1' },
    } as unknown as OrgContext;
    const r = raw[0]!;
    const e = await setPolicy(ctx, { id: r.id, name: 'Owner override', effect: r.effect, source: r.source, enabled: false }).catch(
      (x: unknown) => x,
    );
    expect((e as Error).message).toContain('Default rules are managed by swarmy');
    expect(writes).toEqual([]);
  });
});
