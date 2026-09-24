import { describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../root';
import type { OrgContext } from '../context';
import { isInstanceOwner } from './instance-owner';

/**
 * Instance-wide sign-in config (social providers, magic link, passkeys) is
 * writable only by the owner of the controller's org — the OLDEST org — never
 * by an admin, nor by the owner of some later org (open registration lets
 * anyone create one).
 */

type M = { organizationId: string; userId: string; role: string };

function fakeDb(members: M[], oldestOrg: string | null = 'org_ctrl') {
  const match = (where: Partial<M>) =>
    members.find(
      (m) =>
        (where.organizationId === undefined || m.organizationId === where.organizationId) &&
        (where.userId === undefined || m.userId === where.userId) &&
        (where.role === undefined || m.role === where.role),
    );
  // Plain object (no security models ⇒ enforceOrgMfa's test-double skip).
  return {
    organization: { findFirst: async () => (oldestOrg ? { id: oldestOrg } : null) },
    member: {
      findFirst: async ({ where }: { where: Partial<M> }) => {
        const m = match(where);
        return m ? { id: 'm', role: m.role, organizationId: m.organizationId, createdAt: new Date(0), attributes: {} } : null;
      },
    },
    authProviderConfig: {
      upsert: async () => {
        throw new Error('reached the service');
      },
    },
  };
}

describe('isInstanceOwner', () => {
  it('is true only for an owner of the oldest org', async () => {
    const db = fakeDb([
      { organizationId: 'org_ctrl', userId: 'root', role: 'owner' },
      { organizationId: 'org_ctrl', userId: 'adm', role: 'admin' },
      { organizationId: 'org_late', userId: 'eve', role: 'owner' },
    ]) as never;
    expect(await isInstanceOwner(db, 'root')).toBe(true);
    expect(await isInstanceOwner(db, 'adm')).toBe(false);
    expect(await isInstanceOwner(db, 'eve')).toBe(false);
  });
  it('is false on a controller with no org', async () => {
    expect(await isInstanceOwner(fakeDb([], null) as never, 'root')).toBe(false);
  });
});

describe('authConfig.setProvider is instance-owner-only', () => {
  const caller = (userId: string, activeOrgId: string, members: M[]) =>
    appRouter.createCaller({
      db: fakeDb(members),
      hub: {},
      session: { id: 's1', token: 't1' },
      user: { id: userId, email: `${userId}@example.com`, name: userId },
      activeOrgId,
      reqHeaders: new Headers(),
    } as unknown as OrgContext);

  const input = { type: 'gitlab', enabled: true, clientId: 'x', settings: { issuer: 'https://evil.example' } };

  async function codeOf(p: Promise<unknown>): Promise<string | null> {
    try {
      await p;
      return null;
    } catch (e) {
      return e instanceof TRPCError ? `${e.code}:${e.message}` : `other:${(e as Error).message}`;
    }
  }

  it("refuses the owner of a later org (their own org's owner is not the instance owner)", async () => {
    const members = [
      { organizationId: 'org_ctrl', userId: 'root', role: 'owner' },
      { organizationId: 'org_late', userId: 'eve', role: 'owner' },
    ];
    expect(await codeOf(caller('eve', 'org_late', members).authConfig.setProvider(input))).toStartWith(
      'FORBIDDEN:Only the owner',
    );
  });

  it("refuses an admin of the controller's org", async () => {
    const members = [
      { organizationId: 'org_ctrl', userId: 'root', role: 'owner' },
      { organizationId: 'org_ctrl', userId: 'adm', role: 'admin' },
    ];
    expect(await codeOf(caller('adm', 'org_ctrl', members).authConfig.setProvider(input))).toStartWith(
      'FORBIDDEN:Only the owner',
    );
  });

  it('lets the instance owner through to the service', async () => {
    const members = [{ organizationId: 'org_ctrl', userId: 'root', role: 'owner' }];
    expect(await codeOf(caller('root', 'org_ctrl', members).authConfig.setProvider(input))).toBe(
      'INTERNAL_SERVER_ERROR:reached the service',
    );
  });
});
