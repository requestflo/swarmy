import { describe, expect, it } from 'bun:test';
import { PolicyDto, PolicyList } from '../dto-policies';
import { policyToDto, setPolicyInput } from '../mappers-policies';
import { testApp, type Role } from '../test-kit';
import { memTable } from '../test-mem';

/**
 * /policies rides policies.service: list/get any member's `read` (seeding the
 * defaults), writes `write` + the `policy.write` step. The document is
 * compiled before saving; defaults switch on/off only; an owner lockout is
 * refused — the same refusals the dashboard's rules editor gets, as 400s.
 */

function setup(role: Role = 'owner') {
  const policy = memTable('pol');
  const member = {
    findFirst: async () => ({ id: 'mem1', role, organizationId: 'org1', attributes: {} }),
    findMany: async () => [{ id: 'mem0', userId: 'owner1', role: 'owner', attributes: {} }],
  };
  const $transaction = async (ops: Promise<unknown>[]) => Promise.all(ops);
  return { ...testApp({ role, models: { policy, member, $transaction } }), rows: policy.rows };
}

const doc = JSON.stringify({ roles: ['member'], actions: ['service.restart'], resourceTypes: ['service'] });

describe('policies', () => {
  it('lists the seeded defaults', async () => {
    const t = setup();
    const r = await t.call('GET', '/policies');
    expect(r.status).toBe(200);
    expect(PolicyList.safeParse(r.json).success).toBe(true);
    expect(r.json.data.length).toBeGreaterThan(0);
    expect(r.json.data.every((p: { is_default: boolean }) => p.is_default)).toBe(true);
  });

  it('creates, reads, replaces and deletes a custom rule through policy.write', async () => {
    const t = setup();
    const c = await t.call('POST', '/policies', { name: 'Members restart', effect: 'permit', source: doc });
    expect(c.status).toBe(201);
    expect(PolicyDto.safeParse(c.json).success).toBe(true);
    expect(c.json).toMatchObject({ name: 'Members restart', priority: 0, enabled: true, is_default: false, description: null });
    expect(c.json.sentence).toContain('restart');
    const id = c.json.id as string;

    expect((await t.call('GET', `/policies/${id}`)).json.source).toBe(doc);
    const u = await t.call('PUT', `/policies/${id}`, { name: 'Members restart', effect: 'forbid', source: doc, priority: 5 });
    expect(u.json).toMatchObject({ effect: 'forbid', priority: 5 });
    expect((await t.call('DELETE', `/policies/${id}`)).json).toEqual({ id, removed: true });
    expect((await t.call('GET', `/policies/${id}`)).status).toBe(404);
    expect(t.actions()).toEqual([
      'authz.permit:policy.write', 'policy.create',
      'authz.permit:policy.write', 'policy.update',
      'authz.permit:policy.write', 'policy.delete',
    ]);
  });

  it('refuses an invalid document as tRPC does, with a 400', async () => {
    const t = setup();
    const r = await t.call('POST', '/policies', { name: 'bad', effect: 'permit', source: JSON.stringify({ relations: ['superuser'] }) });
    expect(r.status).toBe(400);
    expect(r.json.detail).toContain('invalid policy');
    expect(t.rows.some((p) => p.name === 'bad')).toBe(false);
  });

  it('defaults: switch off yes, rewrite or delete no (400)', async () => {
    const t = setup();
    // Not "Owners can do anything": switching that off would lock owners out.
    const d = (await t.call('GET', '/policies')).json.data.find((p: { name: string }) => !/owner/i.test(p.name));
    const body = { name: d.name, effect: d.effect, source: d.source, priority: d.priority };
    expect((await t.call('PUT', `/policies/${d.id}`, { ...body, enabled: false })).json.enabled).toBe(false);
    expect((await t.call('PUT', `/policies/${d.id}`, { ...body, name: 'renamed' })).status).toBe(400);
    expect((await t.call('DELETE', `/policies/${d.id}`)).status).toBe(400);
  });

  it('refuses a change that would lock every owner out (POLICY_LOCKOUT)', async () => {
    const t = setup();
    const r = await t.call('POST', '/policies', {
      name: 'No rule changes', effect: 'forbid', source: JSON.stringify({ actions: ['policy.write'] }),
    });
    expect(r.status).toBe(400);
    expect(r.json.swarmy_code).toBe('POLICY_LOCKOUT');
  });

  it('a member key is refused the policy.write step (403)', async () => {
    const r = await setup('member').call('POST', '/policies', { name: 'x', effect: 'permit', source: doc });
    expect(r.status).toBe(403);
    expect(r.json.swarmy_code).toBe('POLICY_DENIED');
  });
});

describe('policy mappers', () => {
  it('maps the view and builds the policies.set input (id only on update)', () => {
    const view = {
      id: 'p1', name: 'n', description: null, effect: 'permit' as const, source: doc, priority: 3, enabled: true,
      isDefault: false, updatedAt: new Date('2026-10-01T00:00:00.000Z'), sentence: 's', doc: null,
    };
    expect(policyToDto(view)).toEqual({
      id: 'p1', name: 'n', description: null, effect: 'permit', source: doc, priority: 3, enabled: true,
      is_default: false, sentence: 's', updated_at: '2026-10-01T00:00:00.000Z',
    });
    expect(setPolicyInput({ name: 'n', effect: 'permit', source: doc })).toEqual({ name: 'n', effect: 'permit', source: doc });
    expect(setPolicyInput({ name: 'n', effect: 'forbid', source: doc }, 'p1').id).toBe('p1');
  });
});
