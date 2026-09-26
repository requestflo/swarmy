import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import { hashToken } from '@swarmy/core/crypto';
import type { AuthedContext, OrgContext } from '../context';
import { seedKv, useMemoryKv } from './swarm-kv.service';
import {
  acceptInviteLink,
  createInviteLink,
  inviteLinkPreview,
  listInviteLinks,
  revokeInviteLink,
} from './inviteLinks.service';

const ORG = 'org_a';
const OTHER = 'org_b';
let t: TestDb;
let admin: OrgContext;
let otherAdmin: OrgContext;
const hub = { liveInventory: () => ({ services: [], containers: [] }) };

async function user(id: string): Promise<AuthedContext> {
  await t.db.user.create({ data: { id, name: id, email: `${id}@x.dev`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
  return { db: t.db, hub, user: { id, email: `${id}@x.dev` }, session: { id: 's' }, reqHeaders: new Headers(), activeOrgId: null } as unknown as AuthedContext;
}

const tokenOf = (url: string) => decodeURIComponent(url.split('/join/')[1] ?? '');

beforeAll(async () => {
  t = await createTestDb();
  useMemoryKv(hub as never);
  seedKv(hub as never, ORG, 'stack', 'st_shop', { name: 'storefront', composeSource: '', ingressDriver: null });
  for (const [org, name] of [[ORG, 'Northwind'], [OTHER, 'Other']] as const) {
    await t.db.organization.create({ data: { id: org, name, slug: org, createdAt: new Date() } });
  }
  for (const [uid, org] of [['u_admin', ORG], ['u_other', OTHER]] as const) {
    await t.db.user.create({ data: { id: uid, name: uid, email: `${uid}@x.dev`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
    await t.db.member.create({ data: { id: `m_${uid}`, organizationId: org, userId: uid, role: 'admin', createdAt: new Date() } });
  }
  const base = { db: t.db, hub, session: { id: 's' }, reqHeaders: new Headers({ origin: 'https://swarmy.northwind.dev' }) };
  admin = { ...base, activeOrgId: ORG, user: { id: 'u_admin' }, membership: { role: 'admin', orgId: ORG } } as unknown as OrgContext;
  otherAdmin = { ...base, activeOrgId: OTHER, user: { id: 'u_other' }, membership: { role: 'admin', orgId: OTHER } } as unknown as OrgContext;
});
afterAll(async () => t?.close());

const audits = async (action: string) => t.db.auditLog.count({ where: { action } });

describe('invite links', () => {
  it('create returns the URL once and stores only the token hash', async () => {
    const link = await createInviteLink(admin, { role: 'member', stackName: 'storefront', expiry: '7d', maxUses: 10 });
    const token = tokenOf(link.url);
    expect(token.startsWith(`swi_${link.prefix}_`)).toBe(true);
    const row = await t.db.inviteLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(link.state).toBe('ok');
    expect(await audits('member.inviteLink.create')).toBeGreaterThan(0);
    const preview = await inviteLinkPreview(t.db, token);
    expect(preview).toMatchObject({ orgName: 'Northwind', role: 'member', stackName: 'storefront', state: 'ok' });
  });

  it('accepting joins the org as a member with an operator grant on the app; uses counts', async () => {
    const link = await createInviteLink(admin, { role: 'member', stackName: 'storefront', expiry: '7d', maxUses: 10 });
    const dev = await user('u_dev');
    const r = await acceptInviteLink(dev, tokenOf(link.url));
    expect(r).toEqual({ orgId: ORG, alreadyMember: false });
    const m = await t.db.member.findFirstOrThrow({ where: { organizationId: ORG, userId: 'u_dev' } });
    expect(m.role).toBe('member');
    const grant = await t.db.resourceGrant.findFirstOrThrow({ where: { principalId: m.id } });
    expect(grant).toMatchObject({ orgId: ORG, resourceType: 'stack', resourceId: 'st_shop', relation: 'operator' });
    expect((await t.db.inviteLink.findUniqueOrThrow({ where: { id: link.id } })).uses).toBe(1);
    expect(await audits('member.inviteLink.accept')).toBeGreaterThan(0);

    // Opening it again as a member: not re-added, no use burned.
    const again = await acceptInviteLink(dev, tokenOf(link.url));
    expect(again.alreadyMember).toBe(true);
    expect(await t.db.member.count({ where: { organizationId: ORG, userId: 'u_dev' } })).toBe(1);
    expect((await t.db.inviteLink.findUniqueOrThrow({ where: { id: link.id } })).uses).toBe(1);
  });

  it('stops at max uses', async () => {
    const link = await createInviteLink(admin, { role: 'admin', expiry: 'never', maxUses: 1 });
    await acceptInviteLink(await user('u_first'), tokenOf(link.url));
    expect((await t.db.member.findFirstOrThrow({ where: { userId: 'u_first' } })).role).toBe('admin');
    await expect(acceptInviteLink(await user('u_second'), tokenOf(link.url))).rejects.toThrow(/used as many times/);
    expect(await t.db.member.count({ where: { userId: 'u_second' } })).toBe(0);
  });

  it('refuses an expired link', async () => {
    const link = await createInviteLink(admin, { role: 'member', expiry: '1d', maxUses: null }, new Date(Date.now() - 2 * 86_400_000));
    await expect(acceptInviteLink(await user('u_late'), tokenOf(link.url))).rejects.toThrow(/expired/);
    expect((await inviteLinkPreview(t.db, tokenOf(link.url)))?.state).toBe('expired');
  });

  it('a revoked link stops working; revoking is org-scoped and audited', async () => {
    const link = await createInviteLink(admin, { role: 'member', expiry: '7d', maxUses: null });
    await expect(revokeInviteLink(otherAdmin, link.id)).rejects.toThrow(/not found/i);
    await revokeInviteLink(admin, link.id);
    expect(await audits('member.inviteLink.revoke')).toBe(1);
    await expect(acceptInviteLink(await user('u_after'), tokenOf(link.url))).rejects.toThrow(/turned off/);
  });

  it('lists only the org’s own links; an admin link can’t be pinned to an app', async () => {
    await createInviteLink(otherAdmin, { role: 'member', expiry: '7d', maxUses: null });
    const mine = await listInviteLinks(admin);
    expect(mine.length).toBeGreaterThan(0);
    const ids = (await t.db.inviteLink.findMany({ where: { orgId: OTHER } })).map((r) => r.id);
    expect(mine.some((l) => ids.includes(l.id))).toBe(false);
    expect(mine[0]?.hint).toContain('/join/swi_');
    await expect(createInviteLink(admin, { role: 'admin', stackName: 'storefront', expiry: '7d', maxUses: 1 })).rejects.toThrow(/every app/);
  });

  it('an unknown token is not found', async () => {
    await expect(acceptInviteLink(await user('u_x'), 'swi_nope_nope')).rejects.toThrow(/does not exist/);
    expect(await inviteLinkPreview(t.db, 'swi_nope_nope')).toBeNull();
  });
});
