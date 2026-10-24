import { describe, expect, it } from 'bun:test';
import type { ContainerInfo, ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { getIngressSettings, updateIngressSettings } from './ingress-settings.service';
import { peekKv, seedKv, useMemoryKv } from './swarm-kv.service';

process.env.SWARMY_SECRET_KEY ??= 'a'.repeat(64);

const EDGE = 'swarmy-ingress-caddy';
const TUNNEL_ID = '0123456789abcdef0123456789abcdef';
const RUN_TOKEN = Buffer.from(JSON.stringify({ a: 'acct', t: TUNNEL_ID, s: 'tunnel-secret-xyz' })).toString('base64');
const DNS_TOKEN = 'cf-dns-token-0123456789-DO-NOT-LEAK';
const CERTS = {
  kind: 's3', endpoint: 'http://swarmy-garage:3900', bucket: 'swarmy-edge-certs', bucketId: 'b1', region: 'garage',
  prefix: 'caddy-enc/org_s', accessKeyId: 'GK1', secretName: 'swarmy-edge-certs-GK1', encSecretName: 'swarmy-edge-certs-enc-1',
};

/** A swarm whose inventory LAGS a deploy (as a real one can): a re-deploy would show as a second command. */
function world(opts: { mode?: 'replicated' | 'global'; settings?: Record<string, unknown>; ingressNode?: boolean; failGlobal?: boolean; fresh?: boolean } = {}) {
  const sent: Array<{ cmd: string; payload: any }> = [];
  const audit: Array<{ action: string; metadata: any }> = [];
  // `fresh`: no edge service and no task yet (a brand-new org).
  const services: SwarmServiceInfo[] = opts.fresh ? [] : [{
    id: 's1', name: EDGE, image: 'caddy', mode: opts.mode ?? 'replicated', desiredReplicas: 1, runningReplicas: 1, createdAt: 0,
    updatedAt: 0, labels: {}, networks: [], env: [], ports: [], secrets: [], configs: [],
  }];
  const task: ContainerInfo = { id: 'c1', name: `${EDGE}.1`, image: 'caddy', state: 'running', status: 'Up', createdAt: 0, ports: [], labels: { 'com.docker.swarm.service.name': EDGE } };
  const db = {
    node: { findMany: async () => [{ id: 'm1' }] },
    statusPage: { findMany: async () => [] },
    inboundEndpoint: { findMany: async () => [] },
    aiProviderConfig: { findUnique: async () => null },
    auditLog: { create: async ({ data }: any) => void audit.push({ action: data.action, metadata: data.metadata }) },
  };
  const hub = {
    isOnline: () => true, managerNode: () => 'm1', managerNodes: () => ['m1'], swarmNodeIdFor: () => undefined,
    nodeInventory: () => [{ swarmNodeId: 'sw1', hostname: 'a', role: 'manager', availability: 'active', status: 'ready', leader: true, labels: opts.ingressNode === false ? {} : { 'swarmy.node.ingress': 'true' } }],
    nodeInfoFor: () => ({ hostname: 'a', labels: {} }),
    liveInventory: () => ({ services, containers: [] }),
    latestContainers: () => (opts.fresh ? [] : [task]),
    dispatch: async (_n: string, cmd: string, payload: any) => {
      sent.push({ cmd, payload });
      if (cmd === 'secret.list') return { secrets: [CERTS.secretName, CERTS.encSecretName].map((name) => ({ id: name, name })) };
      if (cmd === 'service.remove') services.splice(0, 1);
      if (cmd === 'service.deploy' && opts.failGlobal && 'global' in ((payload.spec as ServiceSpec).mode ?? {})) throw new Error('pull failed');
      return {};
    },
  };
  const ctx = { db, hub, activeOrgId: 'org_s', user: { id: 'u1' } } as unknown as OrgContext;
  useMemoryKv(hub as never);
  seedKv(hub as never, 'org_s', 'ingress', 'org_s', { driver: 'CADDY', enabled: true, settings: { certStorage: CERTS, ...opts.settings } });
  seedKv(hub as never, 'org_s', 'storage', 'org_s', { enabled: true, driver: 'GARAGE', region: 'garage', adminTokenRef: encryptSecret('t'), memberNodeIds: ['m1'] });
  const doc = () => peekKv<{ driver: string; settings: Record<string, any> }>(hub as never, 'org_s', 'ingress', 'org_s')!;
  const count = (c: string) => sent.filter((s) => s.cmd === c).length;
  return { ctx, sent, audit, doc, count };
}

describe('updateIngressSettings — one patch, one converge', () => {
  it('saves every field where its setter writes it, deploys once and applies once', async () => {
    const w = world();
    const view = await updateIngressSettings(w.ctx, {
      controllerImage: 'ghcr.io/acme/caddy:1', targetNodes: ['m1'],
      tls: { acmeEmail: 'ops@acme.io', onDemand: true, askUrl: 'https://ctl.acme.io/ask' },
      tunnel: { runToken: RUN_TOKEN, replicas: 2 }, dnsProvider: { provider: 'cloudflare', apiToken: DNS_TOKEN },
    });
    expect(w.count('service.deploy')).toBe(1);
    expect(w.count('applyIngress')).toBe(1);
    expect((w.sent.find((s) => s.cmd === 'service.deploy')!.payload.spec as ServiceSpec).image).toBe('ghcr.io/acme/caddy:1');
    const s = w.doc().settings;
    expect(s.controllerImage).toBe('ghcr.io/acme/caddy:1');
    expect(s.targetNodes).toEqual(['m1']);
    expect(s.globalOptions).toMatchObject({ email: 'ops@acme.io', onDemandTls: true, extraConfig: { onDemandAsk: 'https://ctl.acme.io/ask' } });
    expect(s.tunnel).toMatchObject({ tunnelId: TUNNEL_ID, replicas: 2, tunnelName: 'swarmy' });
    expect(s.acmeDns.byo).toMatchObject({ provider: 'cloudflare', secretName: expect.stringMatching(/^swarmy-acme-dns-byo-/) });
    // Secrets: sealed or in a Docker secret — never in the doc, never in the view.
    expect(JSON.stringify(w.doc())).not.toContain(RUN_TOKEN);
    expect(JSON.stringify(w.doc())).not.toContain(DNS_TOKEN);
    expect(JSON.stringify(view)).not.toContain(s.tunnel.runTokenEnc);
    expect(view.tunnel).toEqual({ tunnelId: TUNNEL_ID, tunnelName: 'swarmy', replicas: 2, runTokenSet: true });
    expect(view.dnsProvider).toMatchObject({ provider: 'cloudflare', apiTokenSet: true });
    expect(view.tls).toEqual({ acmeEmail: 'ops@acme.io', onDemand: true, askUrl: 'https://ctl.acme.io/ask' });
    expect(w.audit.map((a) => a.action)).toEqual(['ingress.updateSettings']);
    expect(w.audit[0]!.metadata.fields).toEqual(['controllerImage', 'targetNodes', 'tls', 'tunnel', 'dnsProvider']);
    expect(JSON.stringify(w.audit)).not.toContain(DNS_TOKEN);
  });

  it('deploys once even before inventory shows the new edge (the apply never re-deploys it)', async () => {
    const w = world({ fresh: true });
    await updateIngressSettings(w.ctx, { driver: 'caddy', enabled: true, targetNodes: [] });
    expect(w.count('service.deploy')).toBe(1);
    expect(w.count('applyIngress')).toBe(0); // no task yet: the reconcile applies when one runs
  });

  it('a TLS-only patch applies without redeploying the edge', async () => {
    const w = world();
    await updateIngressSettings(w.ctx, { tls: { acmeEmail: 'ops@acme.io' } });
    expect(w.count('service.deploy')).toBe(0);
    expect(w.count('applyIngress')).toBe(1);
    expect(w.audit.map((a) => a.action)).toEqual(['ingress.setTls']);
  });

  it('a topology change with an image is ONE swap that carries the image', async () => {
    const w = world();
    await updateIngressSettings(w.ctx, { topology: 'edge-per-node', controllerImage: 'ghcr.io/acme/caddy:2' });
    expect(w.sent.map((s) => s.cmd).filter((c) => c.startsWith('service.'))).toEqual(['service.remove', 'service.deploy']);
    const spec = w.sent.find((s) => s.cmd === 'service.deploy')!.payload.spec as ServiceSpec;
    expect(spec.mode).toEqual({ global: {} });
    expect(spec.image).toBe('ghcr.io/acme/caddy:2');
    expect(w.doc().settings).toMatchObject({ topology: 'edge-per-node', controllerImage: 'ghcr.io/acme/caddy:2' });
  });

  it('a failed swap saves nothing and puts the old edge back', async () => {
    const w = world({ failGlobal: true });
    await expect(updateIngressSettings(w.ctx, { topology: 'edge-per-node', targetNodes: ['m1'] })).rejects.toThrow();
    expect(w.doc().settings.topology).toBeUndefined();
    expect(w.doc().settings.targetNodes).toBeUndefined();
    expect(w.sent.map((s) => s.cmd).filter((c) => c.startsWith('service.'))).toEqual(['service.remove', 'service.deploy', 'service.deploy']);
    expect(w.audit).toEqual([]);
  });
});

describe('updateIngressSettings — the whole patch is validated first', () => {
  const refused = async (patch: unknown, why: RegExp, opts: Parameters<typeof world>[0] = {}) => {
    const w = world(opts);
    const before = JSON.stringify(w.doc());
    await expect(updateIngressSettings(w.ctx, patch)).rejects.toThrow(why);
    expect(w.sent.filter((s) => s.cmd !== 'secret.list')).toEqual([]);
    expect(JSON.stringify(w.doc())).toBe(before);
    expect(w.audit).toEqual([]);
  };
  it('refuses a bad tunnel token even beside valid fields', () =>
    refused({ driver: 'cloudflared', tunnel: { runToken: 'x'.repeat(40) } }, /Cloudflare tunnel token/));
  it('refuses on-demand TLS with neither an email nor an ask endpoint', () =>
    refused({ tls: { onDemand: true } }, /ACME email or an ask endpoint/));
  it('refuses unknown fields and malformed values', async () => {
    await refused({ driver: 'traefik' }, /invalid ingress settings/);
    await refused({ tls: { acmeEmail: 'not-an-email' } }, /invalid ingress settings/);
    await refused({ colour: 'blue' }, /invalid ingress settings/);
  });
  it('keeps the last-edge rule: no ingress node, no edge-per-node', () =>
    refused({ topology: 'edge-per-node', controllerImage: 'x:1' }, /No node is marked as an ingress node/, { ingressNode: false }));
});

describe('setTopology semantics inside the patch', () => {
  it('the current topology (or an empty patch) changes nothing at all', async () => {
    const w = world({ mode: 'global', settings: { topology: 'edge-per-node' } });
    const before = JSON.stringify(w.doc());
    await updateIngressSettings(w.ctx, { topology: 'edge-per-node' });
    await updateIngressSettings(w.ctx, {});
    expect(w.sent).toEqual([]);
    expect(JSON.stringify(w.doc())).toBe(before);
    expect(w.audit).toEqual([]);
    expect((await getIngressSettings(w.ctx)).topology).toBe('edge-per-node');
  });
});
