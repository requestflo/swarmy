import { describe, expect, it } from 'bun:test';
import { poolerSpec } from '@swarmy/core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { getDbPooler } from './manageddb-pooler-view';

const svc = (name: string, labels: Record<string, string>, running = 1): SwarmServiceInfo =>
  ({ id: `id-${name}`, name, image: 'img', mode: 'replicated', runningReplicas: running, desiredReplicas: 1,
    labels: { 'com.docker.stack.namespace': 'shop', ...labels }, networks: [], env: [], ports: [], secrets: [], configs: [], createdAt: 0, updatedAt: 0 }) as unknown as SwarmServiceInfo;
const DECL = '{"mode":"transaction","poolSize":20}';
const primary = svc('shop_main-primary', { 'swarmy.db.cluster': 'main', 'swarmy.db.engine': 'postgres', 'swarmy.db.role': 'primary', 'swarmy.db.pooler': DECL });
const spec = poolerSpec({ stack: 'shop', cluster: 'main', config: { mode: 'transaction', poolSize: 20 }, target: 'shop_main-primary', authSecret: 'shop_main-pg-pooler__v1', image: 'edoburu/pgbouncer:v1.26.1-p0' });
const pooler = { ...svc(spec.name, spec.labels!), image: spec.image };
const app = svc('shop_web', { 'swarmy.db.inject': 'main', 'swarmy.db.inject.via': 'pooler' });
const POOLS = 'database|user|cl_active|cl_waiting|sv_active|sv_idle\napp|postgres|12|1|4|6';

function ctxFor(services: SwarmServiceInfo[], output = POOLS) {
  const containers = services.map((s) => ({ id: `c-${s.name}`, serviceId: s.id, state: 'running', createdAt: 1, labels: {} }));
  const execs: unknown[] = [];
  const ctx = {
    activeOrgId: 'org1',
    hub: {
      liveInventory: () => ({ services, containers }),
      onlineNodeIds: () => ['n1'],
      latestContainers: () => containers,
      dispatch: async (_n: string, cmd: string, payload: { cmd: string[] }) => (execs.push(payload.cmd), cmd === 'exec' ? { exitCode: 0, output } : {}),
    },
  } as unknown as OrgContext;
  return { ctx, execs };
}

describe('getDbPooler (db.pooler)', () => {
  it('shows the declaration, where it points, who goes through it and its live clients', async () => {
    const { ctx, execs } = ctxFor([primary, pooler, app]);
    expect(await getDbPooler(ctx, { stack: 'shop', cluster: 'main' })).toEqual({
      stack: 'shop',
      cluster: 'main',
      declared: { mode: 'transaction', poolSize: 20 },
      service: 'shop_main-pooler',
      address: 'shop_main-pooler:6432',
      status: 'running',
      running: 1,
      desired: 1,
      target: 'shop_main-primary',
      writer: 'shop_main-primary',
      converging: false,
      traffic: { clientsActive: 12, clientsWaiting: 1, serversActive: 4, serversIdle: 6, pools: 1 },
      apps: [{ service: 'shop_web', envVar: 'DATABASE_URL', via: 'pooler' }],
    });
    expect(String((execs[0] as string[])[2])).toContain("SHOW POOLS");
  });

  it('declared but not built yet is converging, with no numbers; off with nothing is quiet', async () => {
    const v = await getDbPooler(ctxFor([primary]).ctx, { stack: 'shop', cluster: 'main' });
    expect([v.status, v.converging, v.traffic, v.target]).toEqual(['absent', true, null, null]);
    const off = svc('shop_main-primary', { 'swarmy.db.cluster': 'main', 'swarmy.db.engine': 'postgres', 'swarmy.db.role': 'primary' });
    const o = await getDbPooler(ctxFor([off]).ctx, { stack: 'shop', cluster: 'main' });
    expect([o.declared, o.converging, o.apps]).toEqual([null, false, []]);
  });
});
