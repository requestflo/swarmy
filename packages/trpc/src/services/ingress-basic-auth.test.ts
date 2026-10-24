import { beforeAll, describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { basicAuthResolver, forgetRoutePasswords, ROUTE_PASSWORDS_KEY, sealRoutePasswords } from './ingress-basic-auth';
import type { Route } from './ingress-routes';
import { peekKv, useMemoryKv } from './swarm-kv.service';

beforeAll(() => {
  process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-route-passwords';
});

const PASSWORD = 'correct horse battery';

function ctx(): OrgContext {
  const hub = { liveInventory: () => ({ services: [], containers: [] }) };
  useMemoryKv(hub as never);
  return { activeOrgId: 'org_1', hub, db: {} } as unknown as OrgContext;
}

function settings(c: OrgContext): Record<string, unknown> {
  return (peekKv<{ settings: Record<string, unknown> }>(c.hub, 'org_1', 'ingress', 'org_1')?.settings ?? {}) as Record<string, unknown>;
}

const route = (users: unknown[]): Route =>
  ({ host: 'admin.acme.com', port: 8080, tls: 'auto', protection: { ipAllow: [], ipDeny: [], blockBots: false, requiredHeaders: [], basicAuth: { users } } }) as Route;

describe('route passwords: hashed, sealed, referenced — never on the label', () => {
  it('a new password becomes a vault reference; the edge resolves it back to a bcrypt hash', async () => {
    const c = ctx();
    const { routes, stale } = await sealRoutePasswords(c, [route([{ username: 'alice', password: PASSWORD }])], []);
    expect(stale).toEqual([]);
    const user = routes[0]?.protection?.basicAuth?.users[0];
    expect(user?.username).toBe('alice');
    expect(user?.passwordSecret).toMatch(/^rpw_[a-f0-9]{24}$/);
    // What the label gets: no password, no hash.
    const label = JSON.stringify(routes);
    expect(label).not.toContain(PASSWORD);
    expect(label).not.toContain('$2');
    // The vault holds a sealed blob, not the hash in the clear.
    const sealed = settings(c)[ROUTE_PASSWORDS_KEY] as Record<string, string>;
    expect(Object.keys(sealed)).toEqual([user!.passwordSecret]);
    expect(sealed[user!.passwordSecret]).not.toContain('$2');
    const resolved = basicAuthResolver(settings(c))(routes[0]?.protection);
    expect(resolved?.users).toHaveLength(1);
    expect(resolved?.users[0]?.hash).toMatch(/^\$2a\$12\$/);
    expect(await Bun.password.verify(PASSWORD, resolved!.users[0]!.hash)).toBe(true);
  });

  it('a kept user keeps their reference; an unknown reference is refused', async () => {
    const c = ctx();
    const first = await sealRoutePasswords(c, [route([{ username: 'alice', password: PASSWORD }])], []);
    const again = await sealRoutePasswords(c, first.routes, first.routes);
    expect(again.routes).toEqual(first.routes);
    expect(again.stale).toEqual([]);
    const forged = sealRoutePasswords(c, [route([{ username: 'eve', passwordSecret: 'rpw_00000000000000000000dead' }])], []);
    await expect(forged).rejects.toBeInstanceOf(TRPCError);
  });

  it('a dropped password is forgotten, and a route still naming it fails closed', async () => {
    const c = ctx();
    const first = await sealRoutePasswords(c, [route([{ username: 'alice', password: PASSWORD }])], []);
    const off: Route = { host: 'admin.acme.com', port: 8080, tls: 'auto' };
    const next = await sealRoutePasswords(c, [off], first.routes);
    const ref = first.routes[0]!.protection!.basicAuth!.users[0]!.passwordSecret;
    expect(next.stale).toEqual([ref]);
    await forgetRoutePasswords(c, next.stale);
    expect(settings(c)[ROUTE_PASSWORDS_KEY]).toEqual({});
    expect(basicAuthResolver(settings(c))(first.routes[0]?.protection)).toEqual({ users: [] });
    expect(basicAuthResolver(settings(c))(undefined)).toBeUndefined();
  });
});
