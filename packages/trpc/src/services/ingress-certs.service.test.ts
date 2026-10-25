import { afterEach, describe, expect, it } from 'bun:test';
import type { EdgeCertFact, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { getCertFacts } from './ingress-certs.service';
import { forgetEdgeCerts, readEdgeCertsAll } from './ingress-certs.read';
import { forgetCertHistories } from './ingress-certs.history';

/**
 * The domain detail's certificate facts come from each edge's own storage
 * (`edge.certs`), only from agents that advertised the read, and an older
 * agent is "not reported", never an error. Against an in-memory hub.
 */

afterEach(() => {
  forgetEdgeCerts();
  forgetCertHistories();
});

const SHOP: EdgeCertFact = {
  name: 'shop.northwind.dev', issuerKey: 'acme-v02.api.letsencrypt.org-directory', issuer: "Let's Encrypt R11",
  notBefore: '2026-09-23T10:00:00.000Z', notAfter: '2026-12-22T10:00:00.000Z',
  names: ['shop.northwind.dev'], serial: '04A1', fingerprint256: 'AA',
};

function svc(routes: object[]): SwarmServiceInfo {
  return {
    id: 'svc1', name: 'shop_web', image: 'web:1', mode: 'replicated', desiredReplicas: 1, runningReplicas: 1, createdAt: 0, updatedAt: 0,
    labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.ingress.routes': JSON.stringify(routes) },
    networks: [], env: [], ports: [], secrets: [], configs: [],
  };
}

let org = 0;
function world(edges: Record<string, { capabilities?: string[]; certs?: EdgeCertFact[]; fails?: string }>) {
  const orgId = `org-certs-${++org}`;
  const calls: Array<{ nodeId: string; cmd: string }> = [];
  const caddy = (id: string) => [{ id: `c-${id}`, state: 'running', labels: { 'com.docker.swarm.service.name': 'swarmy-ingress-caddy' } }];
  const hub = {
    isOnline: () => true,
    latestContainers: (id: string) => (edges[id] ? caddy(id) : []),
    agentBuildFor: (id: string) => ({ version: '1.5.0', ...(edges[id]?.capabilities ? { capabilities: edges[id]!.capabilities } : {}) }),
    liveInventory: () => ({ services: [svc([{ host: 'shop.northwind.dev', port: 3000, tls: 'auto', www: 'redirect-www-to-apex' }])], containers: [] }),
    dispatch: async (nodeId: string, cmd: string) => {
      calls.push({ nodeId, cmd });
      const e = edges[nodeId]!;
      if (e.fails) throw new Error(e.fails);
      return { edge: true, certs: e.certs ?? [], checkedAt: '2026-10-24T12:00:00.000Z' };
    },
  };
  const names: Record<string, string> = { n1: 'london-1', n2: 'new-york-1', n3: 'tokyo-1' };
  const db = { node: { findMany: async () => Object.keys(edges).map((id) => ({ id, name: names[id] ?? id })) } };
  const ctx = { db, hub, activeOrgId: orgId, user: { id: 'u1' } } as unknown as OrgContext;
  return { ctx, calls };
}

describe('getCertFacts', () => {
  it('folds the edges that hold it, and asks only agents that advertised edgeCerts', async () => {
    const w = world({ n1: { capabilities: ['edgeCerts'], certs: [SHOP] }, n2: { capabilities: ['edgeCerts'], certs: [SHOP] }, n3: {} });
    const v = await getCertFacts(w.ctx, 'Shop.Northwind.dev');
    expect(v.source).toBe('edges');
    expect(v.cert).toEqual({ issuer: "Let's Encrypt R11", issuerKey: SHOP.issuerKey, notBefore: SHOP.notBefore, notAfter: SHOP.notAfter, names: SHOP.names, wildcard: null, serial: '04A1' });
    expect(v.edges.map((e) => [e.name, e.state])).toEqual([['london-1', 'holds'], ['new-york-1', 'holds'], ['tokyo-1', 'not_reported']]);
    expect(w.calls.map((c) => c.nodeId).sort()).toEqual(['n1', 'n2']);
    expect(w.calls.every((c) => c.cmd === 'edge.certs')).toBe(true);
  });

  it('only older agents → not reported in plain words, never an error', async () => {
    const w = world({ n1: {} });
    const v = await getCertFacts(w.ctx, 'shop.northwind.dev');
    expect(v.source).toBe('not_reported');
    expect(v.cert).toBeNull();
    expect(v.reason).toBe('Not reported: agent 1.5.0 predates the certificate read (update the agent to see it).');
    expect(w.calls).toEqual([]);
  });

  it('a failed read is that edge’s error; no edge task at all says so', async () => {
    const w = world({ n1: { capabilities: ['edgeCerts'], fails: 'agent did not respond in time' } });
    const v = await getCertFacts(w.ctx, 'shop.northwind.dev');
    expect(v.edges).toEqual([{ nodeId: 'n1', name: 'london-1', state: 'error', reason: 'agent did not respond in time' }]);
    expect((await getCertFacts(world({}).ctx, 'shop.northwind.dev')).source).toBe('no_edges');
  });

  it('a host that is not routed is NOT_FOUND; the www companion is routed', async () => {
    const w = world({ n1: { capabilities: ['edgeCerts'], certs: [SHOP] } });
    await expect(getCertFacts(w.ctx, 'other.dev')).rejects.toThrow('not found');
    expect((await getCertFacts(w.ctx, 'www.shop.northwind.dev')).cert).toBeNull();
  });
});

describe('renewals', () => {
  it('says when Caddy renews (a third of the lifetime left) and a renewal only once a newer notBefore is seen', async () => {
    const certs = [SHOP];
    const w = world({ n1: { capabilities: ['edgeCerts'], certs } });
    const first = await getCertFacts(w.ctx, 'shop.northwind.dev');
    expect(first.renewal?.renewAt).toBe('2026-11-22T10:00:00.000Z');
    expect(first.renewal?.lifetimeDays).toBe(90);
    expect(first.renewals).toEqual([]);
    certs[0] = { ...SHOP, serial: '05B2', fingerprint256: 'BB', notBefore: '2026-11-22T11:00:00.000Z', notAfter: '2027-02-20T11:00:00.000Z' };
    const next = await getCertFacts(w.ctx, 'shop.northwind.dev', { fresh: true });
    expect(next.renewals).toEqual([{ at: '2026-11-22T11:00:00.000Z', issuer: "Let's Encrypt R11", replaced: SHOP.notBefore, by: 'automatic' }]);
  });
});

describe('readEdgeCertsAll', () => {
  it('keeps a round for a minute; fresh asks again', async () => {
    const w = world({ n1: { capabilities: ['edgeCerts'], certs: [SHOP] } });
    await readEdgeCertsAll(w.ctx, { now: 0 });
    await readEdgeCertsAll(w.ctx, { now: 59_000 });
    expect(w.calls.length).toBe(1);
    await readEdgeCertsAll(w.ctx, { now: 59_000, fresh: true });
    expect(w.calls.length).toBe(2);
  });
});
