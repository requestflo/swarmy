import { describe, expect, it } from 'bun:test';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { getIngressSettings, updateIngressSettings } from './ingress-settings.service';
import { DNS_TOKEN, RUN_TOKEN, TUNNEL_ID, world } from './ingress-settings-testing';

describe('updateIngressSettings — one patch, one converge', () => {
  it('a patch of seven fields saves each where its setter writes it, deploys once and applies once', async () => {
    const w = world();
    const view = await updateIngressSettings(w.ctx, {
      controllerImage: 'ghcr.io/acme/caddy:1', targetNodes: ['m1'],
      tls: { acmeEmail: 'ops@acme.io', onDemand: true, askUrl: 'https://ctl.acme.io/ask' },
      tunnel: { runToken: RUN_TOKEN, replicas: 2 }, dnsProvider: { provider: 'cloudflare', apiToken: DNS_TOKEN },
      geoip: { mode: 'file', path: '/geo/country.mmdb' }, autoAddressBase: 'NIP.io',
    });
    expect(w.count('service.deploy')).toBe(1);
    expect(w.count('applyIngress')).toBe(1);
    expect((w.sent.find((s) => s.cmd === 'service.deploy')!.payload.spec as ServiceSpec).image).toBe('ghcr.io/acme/caddy:1');
    const s = w.doc().settings;
    expect(s.controllerImage).toBe('ghcr.io/acme/caddy:1');
    expect(s.targetNodes).toEqual(['m1']);
    expect(s.globalOptions).toMatchObject({ email: 'ops@acme.io', onDemandTls: true, extraConfig: { onDemandAsk: 'https://ctl.acme.io/ask' } });
    expect(s.tunnel).toMatchObject({ tunnelId: TUNNEL_ID, replicas: 2, tunnelName: 'swarmy' });
    expect(s.geoip).toEqual({ mode: 'file', path: '/geo/country.mmdb' });
    expect(s.autoAddressBase).toBe('nip.io');
    expect(view).toMatchObject({ geoip: { mode: 'file', path: '/geo/country.mmdb' }, autoAddressBase: 'nip.io' });
    expect(s.acmeDns.byo).toMatchObject({ provider: 'cloudflare', secretName: expect.stringMatching(/^swarmy-acme-dns-byo-/) });
    // Secrets: sealed or in a Docker secret — never in the doc, never in the view.
    expect(JSON.stringify(w.doc())).not.toContain(RUN_TOKEN);
    expect(JSON.stringify(w.doc())).not.toContain(DNS_TOKEN);
    expect(JSON.stringify(view)).not.toContain(s.tunnel.runTokenEnc);
    expect(view.tunnel).toEqual({ tunnelId: TUNNEL_ID, tunnelName: 'swarmy', replicas: 2, runTokenSet: true });
    expect(view.dnsProvider).toMatchObject({ provider: 'cloudflare', apiTokenSet: true });
    expect(view.tls).toEqual({ acmeEmail: 'ops@acme.io', onDemand: true, askUrl: 'https://ctl.acme.io/ask' });
    expect(w.audit.map((a) => a.action)).toEqual(['ingress.updateSettings']);
    expect(w.audit[0]!.metadata.fields).toEqual(['controllerImage', 'targetNodes', 'tls', 'tunnel', 'dnsProvider', 'geoip', 'autoAddressBase']);
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

  it('an automatic-address base alone neither deploys nor re-renders (domain-verify re-hosts)', async () => {
    const w = world();
    await updateIngressSettings(w.ctx, { autoAddressBase: 'ip.acme.net' });
    expect(w.sent).toEqual([]);
    expect(w.doc().settings.autoAddressBase).toBe('ip.acme.net');
    expect(w.audit.map((a) => a.action)).toEqual(['ingress.setAutoAddressBase']);
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
