import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { seedKv, useMemoryKv } from './swarm-kv.service';
import { searchIndexes, searchQuery } from './search-indexes.service';

/**
 * Service wiring over a fake hub: every index call is ONE `exec` in the
 * engine's running container (never a published port), the script carries
 * no key and no user text, reads are audited, and "Try it" runs the
 * `data.read` gate before it touches the engine.
 */

const engine = {
  id: 'svc-search', name: 'shop_main-search', image: 'getmeili/meilisearch:v1.12', mode: 'replicated',
  replicas: 1, runningReplicas: 1, desiredReplicas: 1,
  labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.search.engine': 'meilisearch', 'swarmy.search.cluster': 'main' },
  networks: [], env: [], ports: [], createdAt: 0, updatedAt: 0,
};
const container = {
  id: 'ctr-search', name: 'shop_main-search.1', image: engine.image, state: 'running', status: 'Up',
  serviceId: 'svc-search', labels: { 'com.docker.swarm.service.id': 'svc-search' },
};

type Exec = { cmd: string[] };
export function ctxWith(role: 'owner' | 'member', answer: (script: string) => Array<[number, unknown]>, labels: Record<string, string> = {}) {
  const audit: { action: string; metadata: Record<string, unknown> }[] = [];
  const sent: { node: string; cmd: string; payload: Exec }[] = [];
  const hub = {
    liveInventory: () => ({ services: [{ ...engine, labels: { ...engine.labels, ...labels } }], containers: [container] }),
    onlineNodeIds: () => ['node-a'],
    latestContainers: () => [container],
    managerNode: () => 'node-a',
    nodeInfoFor: () => undefined,
    dispatch: async (node: string, cmd: string, payload: Exec) => {
      sent.push({ node, cmd, payload });
      const script = payload.cmd[2] ?? '';
      const marker = /-w '\\n(@@[a-z0-9]+) /.exec(script)?.[1] ?? '';
      const output = answer(script).map(([status, body]) => `${JSON.stringify(body)}\n${marker} ${status}\n`).join('');
      return { exitCode: 0, output };
    },
  };
  useMemoryKv(hub as never);
  seedKv(hub as never, 'org1', 'stack', 'st1', { name: 'shop', ingressDriver: null });
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    session: { id: 's1' },
    membership: { role, orgId: 'org1' },
    reqHeaders: new Headers(),
    db: {
      member: { findFirst: async () => ({ id: 'mem1', role, organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      auditLog: { create: async ({ data }: { data: { action: string; metadata: Record<string, unknown> } }) => void audit.push(data) },
    },
    hub,
  } as unknown as OrgContext;
  return { ctx, audit, sent };
}

describe('search indexes service', () => {
  it('lists indexes with one exec in the engine container and audits the read', async () => {
    const { ctx, audit, sent } = ctxWith('owner', () => [
      [200, { results: [{ uid: 'products', primaryKey: 'sku', updatedAt: '2026-10-24T09:00:00Z' }], total: 1 }],
      [200, { databaseSize: 9, indexes: { products: { numberOfDocuments: 41208 } } }],
    ]);
    const v = await searchIndexes(ctx, { stack: 'shop', name: 'main' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ node: 'node-a', cmd: 'exec', payload: { target: { containerId: 'ctr-search' } } });
    expect(sent[0]!.payload.cmd.slice(0, 2)).toEqual(['sh', '-c']);
    expect(v).toMatchObject({ supported: true, total: 1, truncated: false, dbSizeBytes: 9 });
    expect(v.indexes[0]).toMatchObject({ uid: 'products', docs: 41208 });
    expect(audit.map((a) => a.action)).toEqual(['search.indexes.read']);
  });

  it('a Typesense instance says unsupported without touching the engine', async () => {
    const { ctx, sent } = ctxWith('owner', () => [], { 'swarmy.search.engine': 'typesense' });
    expect(await searchIndexes(ctx, { stack: 'shop', name: 'main' })).toMatchObject({ supported: false, indexes: [] });
    expect(sent).toHaveLength(0);
  });

  it('Try it sends the query as $1 (never in the script) and records one search.query row', async () => {
    const { ctx, audit, sent } = ctxWith('owner', () => [
      [200, { uid: 'products', primaryKey: 'sku' }],
      [200, { hits: [{ sku: 'MUG-1', title: 'Enamel mug', _rankingScore: 0.9 }], processingTimeMs: 2, estimatedTotalHits: 7 }],
    ]);
    const q = 'mug"; cat /run/secrets/search-master-key; echo "';
    const r = await searchQuery(ctx, { stack: 'shop', name: 'main', index: 'products', q });
    const cmd = sent[0]!.payload.cmd;
    expect(cmd[2]).not.toContain('mug"');
    expect(JSON.parse(cmd[4]!)).toEqual({ q, limit: 5, showRankingScore: true });
    expect(r).toMatchObject({ estimatedTotal: 7, processingTimeMs: 2, hits: [{ id: 'MUG-1', title: 'Enamel mug', score: 0.9 }] });
    expect(audit.map((a) => a.action)).toEqual(['search.query']);
  });

  it('a member is refused Try it on a production stack — audited, the engine never asked', async () => {
    const { ctx, audit, sent } = ctxWith('member', () => [], { 'swarmy.env': 'production' });
    await expect(searchQuery(ctx, { stack: 'shop', name: 'main', index: 'products', q: 'mug' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(sent).toHaveLength(0);
    expect(audit.map((a) => a.action)).toEqual(['authz.deny:data.read']);
  });

  it('a 404 from the engine is NOT_FOUND', async () => {
    const { ctx } = ctxWith('owner', () => [[404, { message: 'Index `nope` not found.', code: 'index_not_found' }]]);
    await expect(searchQuery(ctx, { stack: 'shop', name: 'main', index: 'nope', q: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
