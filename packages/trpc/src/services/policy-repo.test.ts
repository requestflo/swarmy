import { describe, expect, it } from 'bun:test';
import { defaultPolicyInputs } from '@swarmy/abac';
import type { DB } from '@swarmy/db';
import { defaultsDrift, prismaPolicyRepository } from './policy-repo';

const shipped = () =>
  defaultPolicyInputs().map((p, i) => ({
    id: `d${i}`,
    name: p.name,
    effect: p.effect,
    source: p.source,
    priority: p.priority,
    enabled: true,
    isdefault: true,
  }));

describe('defaultsDrift (managed defaults)', () => {
  const rec = (r: ReturnType<typeof shipped>[number]) => ({ ...r, isDefault: r.isdefault });
  it('is quiet when the stored defaults equal the shipped set (or there are no rows)', () => {
    expect(defaultsDrift(shipped().map(rec))).toBe(false);
    expect(defaultsDrift([])).toBe(false);
  });
  it('flags an edited, missing or extra default row', () => {
    const edited = shipped().map(rec);
    edited[0]!.source = '{"actions":["*"]}';
    expect(defaultsDrift(edited)).toBe(true);
    expect(defaultsDrift(shipped().map(rec).slice(1))).toBe(true);
    expect(defaultsDrift([...shipped().map(rec), { ...rec(shipped()[0]!), name: 'old default' }])).toBe(true);
  });
});

describe('ensureDefaults rewrites stale defaults automatically', () => {
  it('replaces drifted default rows, keeps custom rows and an admin disable', async () => {
    let rows: Array<Record<string, unknown>> = [
      ...shipped().map((r, i) => (i === 0 ? { ...r, enabled: false } : r)),
      { id: 'old', name: 'Members can run safe operations', effect: 'permit', source: '{}', priority: 40, enabled: true, isdefault: true },
      { id: 'c1', name: 'custom', effect: 'forbid', source: '{}', priority: 5, enabled: true, isdefault: false },
    ];
    const db = {
      policy: {
        findMany: async () => rows,
        deleteMany: ({ where }: { where: { isdefault: boolean } }) => ({ kind: 'delete', where }),
        createMany: ({ data }: { data: Array<Record<string, unknown>> }) => ({ kind: 'create', data }),
      },
      $transaction: async (ops: Array<{ kind: string; data?: Array<Record<string, unknown>> }>) => {
        rows = rows.filter((r) => !r.isdefault);
        for (const op of ops) if (op.kind === 'create') rows.push(...op.data!);
      },
    } as unknown as DB;
    const repo = prismaPolicyRepository(db);
    expect(await repo.ensureDefaults('org')).toBe(true);
    const names = rows.filter((r) => r.isdefault).map((r) => r.name);
    expect(names).toEqual(defaultPolicyInputs().map((p) => p.name));
    expect(rows.find((r) => r.name === defaultPolicyInputs()[0]!.name)!.enabled).toBe(false);
    expect(rows.some((r) => r.id === 'c1')).toBe(true);
    expect(await repo.ensureDefaults('org')).toBe(false);
  });
});
