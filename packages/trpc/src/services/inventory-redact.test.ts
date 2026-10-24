import { describe, expect, it } from 'bun:test';
import type { Inventory, InvService } from '@swarmy/core';
import type { OrgContext } from '../context';
import { redactInventoryFor } from './inventory-redact';
import { REDACTED } from './secret-redact';

const svc = (id: string, labels: Record<string, string> = {}): InvService => ({
  id, name: id, image: 'x', stack: 'shop', mode: 'replicated', replicas: { desired: 1, running: 1 },
  status: 'running', scaleToZero: false, labels, networks: [], ports: [], containers: [],
  env: ['PORT=3000', 'REDIS_PASS=hunter2', 'DATABASE_URL=postgres://u:pw@db/app'],
});
const INV: Inventory = { projects: [{ name: 'shop', serviceIds: ['web', 'api'] }], services: [svc('web'), svc('api')], edges: [] };

function ctxFor(role: 'owner' | 'member', opts: { policies?: unknown[]; grants?: unknown[] } = {}) {
  const grantQueries: unknown[] = [];
  const ctx = {
    db: {
      member: { findFirst: async () => ({ id: 'm1', role, attributes: {} }) },
      policy: { findMany: async () => opts.policies ?? [] },
      resourceGrant: {
        findMany: async (q: unknown) => {
          grantQueries.push(q);
          return opts.grants ?? [];
        },
      },
    },
    activeOrgId: 'org1',
    user: { id: 'u1' },
    membership: { role, orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return { ctx, grantQueries };
}

const envOf = (inv: Inventory, id: string) => inv.services.find((s) => s.id === id)!.env;

describe('inventory.get masks secret env without secrets.read (security review M3)', () => {
  it('an owner sees every value', async () => {
    const out = await redactInventoryFor(ctxFor('owner').ctx, INV);
    expect(envOf(out, 'web')).toEqual(INV.services[0]!.env);
  });

  it('a member gets the key names with secret-looking values masked; links and shape stay', async () => {
    const out = await redactInventoryFor(ctxFor('member').ctx, INV);
    expect(envOf(out, 'web')).toEqual(['PORT=3000', `REDIS_PASS=${REDACTED}`, `DATABASE_URL=${REDACTED}`]);
    expect(out.projects).toEqual(INV.projects);
    expect(INV.services[0]!.env[1]).toBe('REDIS_PASS=hunter2');
  });

  it('decides per service: an owner grant + a relation rule reveals that one only, with one grant query', async () => {
    const rule = {
      id: 'own-secrets', name: 'owners of a service read its secrets', effect: 'permit', priority: 10, enabled: true,
      source: JSON.stringify({ relations: ['owner'], actions: ['secrets.read'] }),
    };
    const grant = { principalType: 'member', principalId: 'm1', resourceType: 'service', resourceId: 'api', relation: 'owner' };
    const { ctx, grantQueries } = ctxFor('member', { policies: [rule], grants: [grant] });
    const out = await redactInventoryFor(ctx, INV);
    expect(envOf(out, 'api')).toEqual(INV.services[1]!.env);
    expect(envOf(out, 'web')[1]).toBe(`REDIS_PASS=${REDACTED}`);
    expect(grantQueries).toHaveLength(1);
  });
});
