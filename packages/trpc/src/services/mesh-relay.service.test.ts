import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-mesh-relay-service-0123456789';

const { encryptSecret } = await import('@swarmy/core/crypto');
const { renderControlSpec } = await import('./mesh-control.service');
const { reconcileEdgeRelays, relayEdges, relaysWanted } = await import('./mesh-relay.service');
const { meshRelayLive } = await import('./mesh-relay-live');
type M = Parameters<typeof renderControlSpec>[0];

let m: M;
beforeAll(() => {
  m = {
    cluster: 'lon',
    meshDomain: 'mesh.example.com',
    tls: { mode: 'edge', listen: '172.17.0.1:8081' },
    authSecretEnc: encryptSecret('relay-secret-0123456789'),
    encryptionKeyEnc: encryptSecret('MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='),
    relaysOnEdges: true,
    controlNodeId: 'cp',
  };
});
beforeEach(() => meshRelayLive.clear());

const ORG = 'org1';
const nodes: Record<string, { hostname: string; addr?: string; labels: Record<string, string> }> = {
  cp: { hostname: 'lon-1', addr: '100.92.0.1:2377', labels: { 'swarmy.node.ingress': 'true', 'swarmy.node.public-ip': '198.51.100.10' } },
  e2: { hostname: 'nyc-1', addr: '100.92.0.2', labels: { 'swarmy.node.ingress': 'true', 'swarmy.node.public-ip': '10.0.0.5', 'swarmy.node.public-ip.override': '198.51.100.20' } },
  lan: { hostname: 'home', addr: '100.92.0.3', labels: { 'swarmy.node.ingress': 'true', 'swarmy.node.public-ip': '192.168.1.4' } },
};

function ctx(opts: { online?: string[]; fail?: string[] } = {}) {
  const calls: string[] = [];
  const hub = {
    nodesByRole: () => Object.keys(nodes),
    nodeInfoFor: (id: string) => nodes[id],
    isOnline: (id: string) => (opts.online ?? Object.keys(nodes)).includes(id),
    dispatch: async (id: string, cmd: string, p: { action: string; spec?: { stun: boolean } }) => {
      calls.push(`${id} ${cmd} ${p.action}${p.spec ? ` stun=${p.spec.stun}` : ''}`);
      if (opts.fail?.includes(id)) throw new Error('boom');
      return { running: true, healthy: false };
    },
  };
  return { c: { activeOrgId: ORG, hub } as never, calls };
}

describe('relays on edges (controller glue)', () => {
  test('wanted only when switched on, behind the edge and past the TLS handover', () => {
    expect(relaysWanted(m)).toBe(true);
    expect(relaysWanted({ ...m, relaysOnEdges: false })).toBe(false);
    expect(relaysWanted({ ...m, tls: { mode: 'letsencrypt' } })).toBe(false);
    expect(relaysWanted({ ...m, bootstrapTls: { mode: 'none', port: 8081 } })).toBe(false);
    expect(relaysWanted({ ...m, bootstrapTls: { mode: 'none', port: 8081 }, handedOverAt: 1 })).toBe(true);
  });

  test('edges: public IPv4 only (the override wins), mesh address from the swarm address', () => {
    expect(relayEdges(ctx().c)).toEqual([
      { nodeId: 'cp', hostname: 'lon-1', publicIp: '198.51.100.10', meshIp: '100.92.0.1' },
      { nodeId: 'e2', hostname: 'nyc-1', publicIp: '198.51.100.20', meshIp: '100.92.0.2' },
    ]);
  });

  test('first tick: a relay on every edge (none with STUN on the control node), nothing listed yet', async () => {
    const { c, calls } = ctx();
    const r = await reconcileEdgeRelays(c, m, { authSecret: 'relay-secret-0123456789', controlNodeId: 'cp', controlRunsExternal: false, base: 'sslip.io' });
    expect(calls).toEqual(['cp mesh.relay apply stun=false', 'e2 mesh.relay apply stun=true']);
    expect(r.next).toBeNull();
  });

  test('a healthy relay lists them all; NetBird then renders relays + STUN (and no relay of its own)', async () => {
    meshRelayLive.report(ORG, 'e2', { running: true, healthy: true });
    const r = await reconcileEdgeRelays(ctx().c, m, { authSecret: 'relay-secret-0123456789', controlNodeId: 'cp', controlRunsExternal: false, base: 'sslip.io' });
    expect(r.next).toEqual({
      addresses: ['rels://relay.198-51-100-10.sslip.io:443', 'rels://relay.198-51-100-20.sslip.io:443'],
      stuns: ['stun:198.51.100.10:3478', 'stun:198.51.100.20:3478'],
    });
    const cfg = JSON.parse(renderControlSpec({ ...m, relays: { ...r.next!, since: 1 } }).configYaml.split('\n').slice(1).join('\n')).server;
    expect(cfg.relays.addresses).toEqual(r.next!.addresses);
    expect(cfg.stuns.map((x: { uri: string }) => x.uri)).toEqual(r.next!.stuns);
    // Never during the bootstrap (plain) phase: there are no edge vhosts for it yet.
    const boot = renderControlSpec({ ...m, bootstrapTls: { mode: 'none', port: 8081 }, relays: { ...r.next!, since: 1 } });
    expect(boot.configYaml).not.toContain('"relays"');
  });

  test('turning it off stops the relays first; a failed stop on the control node keeps the list', async () => {
    const list = { addresses: ['rels://relay.198-51-100-10.sslip.io:443'], stuns: ['stun:198.51.100.10:3478'] };
    meshRelayLive.report(ORG, 'cp', { running: true, healthy: true, stun: true });
    meshRelayLive.report(ORG, 'e2', { running: true, healthy: true, stun: true });
    const off = { ...m, relaysOnEdges: false, relays: { ...list, since: 1 } };
    const ok = ctx();
    expect((await reconcileEdgeRelays(ok.c, off, { authSecret: 'relay-secret-0123456789', controlNodeId: 'cp', controlRunsExternal: true, base: 'sslip.io' })).next).toBeNull();
    expect(ok.calls).toEqual(['cp mesh.relay stop', 'e2 mesh.relay stop']);

    meshRelayLive.report(ORG, 'cp', { running: true, healthy: true, stun: true });
    const bad = ctx({ fail: ['cp'] });
    const r = await reconcileEdgeRelays(bad.c, off, { authSecret: 'relay-secret-0123456789', controlNodeId: 'cp', controlRunsExternal: true, base: 'sslip.io' });
    expect(r.next).toEqual(list);
    expect(r.steps.some((s) => s.includes('relay stop on cp failed'))).toBe(true);
  });

  test('offline nodes are skipped, never dispatched to', async () => {
    const { c, calls } = ctx({ online: ['e2'] });
    await reconcileEdgeRelays(c, m, { authSecret: 'relay-secret-0123456789', controlNodeId: 'cp', controlRunsExternal: false, base: 'sslip.io' });
    expect(calls).toEqual(['e2 mesh.relay apply stun=true']);
  });
});
