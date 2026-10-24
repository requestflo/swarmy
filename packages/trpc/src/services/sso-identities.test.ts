import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { deleteSsoProvider, upsertSsoProvider } from './sso.service';

let t: TestDb;
const ADMIN: Record<string, string> = { org_a: 'ann', org_b: 'eve' };
const ctxFor = (orgId: string) => ({ db: t.db, activeOrgId: orgId, user: { id: ADMIN[orgId] } }) as unknown as OrgContext;

async function person(id: string, orgId: string | null) {
  await t.db.user.create({ data: { id, name: id, email: `${id}@x.io` } });
  if (orgId) await t.db.member.create({ data: { id: `m_${id}`, organizationId: orgId, userId: id, role: 'member' } });
}

async function identity(userId: string, providerId: string) {
  await t.db.account.create({ data: { id: `acc_${userId}_${providerId}`, userId, providerId, accountId: `sub_${userId}` } });
}

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof TRPCError ? e.code : String(e)));
const accounts = async (providerId: string) =>
  (await t.db.account.findMany({ where: { providerId }, orderBy: { userId: 'asc' } })).map((a) => a.userId);

beforeAll(async () => {
  t = await createTestDb();
  for (const id of ['org_a', 'org_b']) await t.db.organization.create({ data: { id, name: id, slug: id } });
  await person('ann', 'org_a');
  await person('bob', 'org_a');
  await person('eve', 'org_b');
});
afterAll(async () => t?.close());

describe('SSO provider identities (deleted providers can’t be reclaimed)', () => {
  it('deleting a provider deletes its account rows and retires the id to the org', async () => {
    const p = await upsertSsoProvider(ctxFor('org_a'), { providerId: 'acme', protocol: 'oidc' });
    await identity('ann', 'acme');
    await identity('bob', 'acme');
    await deleteSsoProvider(ctxFor('org_a'), p.id);
    expect(await accounts('acme')).toEqual([]);
    const audit = await t.db.auditLog.findFirst({ where: { action: 'sso.delete' } });
    expect(audit?.metadata).toEqual({ providerId: 'acme', identitiesRemoved: 2 });
  });

  it('another org can’t re-create a retired id; the owning org can', async () => {
    expect(await code(upsertSsoProvider(ctxFor('org_b'), { providerId: 'acme', protocol: 'oidc' }))).toBe('CONFLICT');
    expect(await code(upsertSsoProvider(ctxFor('org_a'), { providerId: 'acme', protocol: 'oidc' }))).toBe('ok');
    expect(await code(upsertSsoProvider(ctxFor('org_b'), { providerId: 'acme', protocol: 'oidc' }))).toBe('CONFLICT');
  });

  it('leftover rows belonging to people outside the org block the id (pre-fix data, deleted orgs)', async () => {
    await identity('eve', 'legacy');
    expect(await code(upsertSsoProvider(ctxFor('org_a'), { providerId: 'legacy', protocol: 'oidc' }))).toBe('CONFLICT');
    expect(await code(upsertSsoProvider(ctxFor('org_b'), { providerId: 'legacy', protocol: 'oidc' }))).toBe('ok');
  });

  it('a rename moves the identities to the new id and retires the old one', async () => {
    const p = await upsertSsoProvider(ctxFor('org_a'), { providerId: 'kc-old', protocol: 'oidc' });
    await identity('ann', 'kc-old');
    // Into an id another org holds or retired: refused, nothing moves.
    expect(await code(upsertSsoProvider(ctxFor('org_a'), { id: p.id, providerId: 'legacy', protocol: 'oidc' }))).toBe('CONFLICT');
    await upsertSsoProvider(ctxFor('org_a'), { id: p.id, providerId: 'kc-new', protocol: 'oidc' });
    expect(await accounts('kc-old')).toEqual([]);
    expect(await accounts('kc-new')).toEqual(['ann']);
    expect(await code(upsertSsoProvider(ctxFor('org_b'), { providerId: 'kc-old', protocol: 'oidc' }))).toBe('CONFLICT');
  });
});
