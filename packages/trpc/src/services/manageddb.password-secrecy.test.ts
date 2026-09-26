import { describe, expect, it } from 'bun:test';
import type { SwarmNodeInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { maskUrlPassword } from '../routers/manageddb';
import { provisionDb, provisionDbWithPassword, revealDbPassword } from './manageddb.service';

/**
 * Security: `db.provision` never returns the cluster password. A client reads
 * it only through `db.revealPassword` (gated on `secrets.read` — see
 * security-gates.test.ts — and audited as `db.password.reveal`).
 */

const SECRET = 'hunter2-very-secret-pg-password';
const node = { swarmNodeId: 'swarm-a', hostname: 'a', role: 'manager', status: 'ready', availability: 'active', labels: {} } as unknown as SwarmNodeInfo;

function world(services: SwarmServiceInfo[] = []) {
  const audit: Array<{ action: string; metadata?: unknown }> = [];
  const ctx = {
    db: { auditLog: { create: ({ data }: { data: { action: string; metadata?: unknown } }) => (audit.push(data), Promise.resolve({})) } },
    hub: {
      managerNode: () => 'node1',
      isOnline: () => true,
      onlineNodeIds: () => ['node1'],
      latestContainers: () => [],
      nodeInventory: () => [node],
      swarmNodeIdFor: () => 'swarm-a',
      nodeInfoFor: () => undefined,
      liveInventory: () => ({ services, containers: [] }),
      dispatch: () => Promise.resolve({}),
    },
    user: { id: 'u1' },
    activeOrgId: 'org1',
    membership: { role: 'owner', orgId: 'org1' },
  } as unknown as OrgContext;
  return { ctx, audit };
}

describe('db.provision never returns the password', () => {
  it('the result has no password field and carries the value nowhere', async () => {
    const { ctx } = world();
    const res = await provisionDb(ctx, { stack: 'shop', name: 'main', replicas: 0, password: SECRET, autoBackup: false });
    expect('password' in res).toBe(false);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(res.passwordEnv).toBe('POSTGRES_PASSWORD_FILE');
    expect(res.passwordSecret).toBe('shop_main-pg-password__v1');
  });

  it('only the server-side variant hands the password back (blueprint tokens)', async () => {
    const { ctx } = world();
    const res = await provisionDbWithPassword(ctx, { stack: 'shop', name: 'main', replicas: 0, password: SECRET, autoBackup: false });
    expect(res.password).toBe(SECRET);
  });
});

describe('db.revealPassword', () => {
  const primary = {
    id: 'p1',
    name: 'shop_main-primary',
    image: 'pgvector/pgvector:pg17',
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: 0,
    updatedAt: 0,
    labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'main', 'swarmy.db.role': 'primary', 'swarmy.db.engine': 'postgres' },
    networks: [],
    env: [`POSTGRES_PASSWORD=${SECRET}`],
    ports: [],
  } as unknown as SwarmServiceInfo;

  it('reads the password from Docker truth and audits the reveal (never the value)', async () => {
    const { ctx, audit } = world([primary]);
    expect(await revealDbPassword(ctx, { stack: 'shop', cluster: 'main' })).toEqual({ cluster: 'main', password: SECRET });
    expect(audit.map((a) => a.action)).toEqual(['db.password.reveal']);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  it('an unknown cluster is not found', async () => {
    const { ctx } = world([]);
    await expect(revealDbPassword(ctx, { stack: 'shop', cluster: 'nope' })).rejects.toThrow();
  });
});

describe('db.inject response masks the URL password', () => {
  it('postgres://user:secret@host → postgres://user:***@host', () => {
    expect(maskUrlPassword(`postgres://postgres:${SECRET}@shop_main-primary:5432/app`)).toBe(
      'postgres://postgres:***@shop_main-primary:5432/app',
    );
  });
});
