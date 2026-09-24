import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '@swarmy/trpc';
import { createRestApp } from './app';

/**
 * REST twin of `adminProcedure`: every REST mutation whose tRPC procedure is
 * admin-only must refuse a member's API key BEFORE any service code runs (an
 * API key acts as its creator's current role). The table is the contract —
 * add a row whenever a route rides an adminProcedure service function.
 */

type Role = 'owner' | 'admin' | 'member';

function appFor(role: Role) {
  const db = new Proxy({} as Record<string, unknown>, {
    get: () => new Proxy({}, { get: () => async () => { throw new Error('reached the service layer'); } }),
  });
  const hub = new Proxy({}, { get: () => () => { throw new Error('reached the hub'); } });
  const ctx = {
    db,
    hub,
    user: { id: 'user1' },
    activeOrgId: 'org1',
    membership: { role, orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return createRestApp({
    resolveContextFromApiKey: async () => ({ ctx, apiKey: { id: 'k1', scopes: ['write'] } }),
  });
}

// [method, path, body, the tRPC twin that is adminProcedure]
const ADMIN_ROUTES: Array<[string, string, unknown, string]> = [
  ['POST', '/api-keys', { name: 'ci', scopes: ['read'] }, 'apiKeys.create'],
  ['POST', '/backup-targets', { name: 't', kind: 's3', url: 's3:x' }, 'backups.addTarget'],
  ['POST', '/dns/zones', { name: 'example.com' }, 'geodns.createZone'],
  ['POST', '/dns/zones/z1/records', { name: 'www', type: 'A', value: '1.2.3.4' }, 'geodns.upsertRecord'],
  ['POST', '/mesh/routes', { service_id: 's1' }, 'mesh.routes.grant'],
  ['POST', '/registry-credentials', { prefix: 'ghcr.io', username: 'u', secret: 's' }, 'registryCredentials.upsert'],
  ['PATCH', '/registry-credentials/rc1', { username: 'u' }, 'registryCredentials.update'],
  ['POST', '/registry-credentials/rc1/test', {}, 'registryCredentials.test'],
  ['POST', '/volumes', { name: 'v', driver: 'csi' }, 'volumes.registerCluster'],
  ['POST', '/git/connections', { kind: 'gitlab', mode: 'token', token: 'glpat-12345678' }, 'gitConnections.create'],
  ['POST', '/git/repos', { url: 'https://x/y.git', branch: 'main' }, 'gitConnections.linkRepo'],
  ['PATCH', '/git/repos/gr1', { branch: 'main' }, 'gitConnections.updateRepo'],
  ['PUT', '/apps/gr1/require-approval', { require_approval: true }, 'apps.setRequireApproval'],
  ['POST', '/apps/gr1/deploy', {}, 'apps.deploy'],
  ['PUT', '/apps/gr1/enforce-drift', { enforce_drift: true }, 'apps.setEnforceDrift'],
  ['POST', '/apps/gr1/promote', { from: 'staging' }, 'apps.promote'],
];

const call = (role: Role, method: string, path: string, body: unknown) =>
  appFor(role).request(`/${path.replace(/^\//, '')}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer swk_test' },
    body: JSON.stringify(body),
  });

describe('REST admin gates mirror adminProcedure', () => {
  for (const [method, path, body, twin] of ADMIN_ROUTES) {
    it(`${method} ${path} (${twin}) refuses a member key`, async () => {
      const res = await call('member', method, path, body);
      expect(res.status).toBe(403);
      const j = (await res.json()) as { swarmy_code?: string; detail?: string; title?: string };
      expect(j.swarmy_code).toBe('POLICY_DENIED');
    });

    it(`${method} ${path} lets an admin key past the gate`, async () => {
      const res = await call('admin', method, path, body);
      // Past the gate the fake service layer throws — anything but the admin 403.
      if (res.status === 403) {
        const j = (await res.json()) as { detail?: string; title?: string };
        expect(`${j.title ?? ''} ${j.detail ?? ''}`).not.toContain('requires admin or owner');
      }
    });
  }
});
