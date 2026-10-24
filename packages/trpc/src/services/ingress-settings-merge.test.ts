import { describe, expect, it } from 'bun:test';
import { currentFacts, ingressAudit, ingressSettingsView, mergeIngressPatch, type IngressDoc } from './ingress-settings-merge';
import { assertIngressPatch, parseIngressPatch } from './ingress-settings.schema';

const doc = (settings: Record<string, unknown> = {}): IngressDoc => ({ driver: 'CADDY', enabled: true, settings });
const BYO = { provider: 'cloudflare' as const, secretName: 'swarmy-acme-dns-byo-abc', setAt: '2026-10-24T00:00:00.000Z' };

describe('mergeIngressPatch — each field lands where its setter wrote it', () => {
  it('TLS: undefined keeps, null clears, a value sets (email on globalOptions, ask on extraConfig)', () => {
    const start = doc({ globalOptions: { email: 'a@x.io', onDemandTls: true, extraConfig: { onDemandAsk: 'https://x/ask', applyVia: 'exec' } } });
    expect(mergeIngressPatch(start, { tls: { onDemand: false } }, {}).settings.globalOptions).toEqual({
      email: 'a@x.io', onDemandTls: false, extraConfig: { onDemandAsk: 'https://x/ask', applyVia: 'exec' },
    });
    expect(mergeIngressPatch(start, { tls: { acmeEmail: null, askUrl: null } }, {}).settings.globalOptions).toEqual({
      onDemandTls: true, extraConfig: { applyVia: 'exec' },
    });
  });

  it('driver, enabled, image (null = default) and target nodes', () => {
    const out = mergeIngressPatch(doc({ controllerImage: 'old:1' }), { driver: 'cloudflared', enabled: false, controllerImage: null, targetNodes: ['n1'] }, {});
    expect(out.driver).toBe('CLOUDFLARE_TUNNEL');
    expect(out.enabled).toBe(false);
    expect(out.settings.controllerImage).toBeUndefined();
    expect(out.settings.targetNodes).toEqual(['n1']);
  });

  it('tunnel: a new token is sealed in; a name-only change keeps it; null disconnects', () => {
    const connected = mergeIngressPatch(doc(), { tunnel: { runToken: 'x'.repeat(30) } }, { runTokenEnc: 'enc1', tunnelId: 't1' });
    expect(connected.settings.tunnel).toEqual({ provider: 'cloudflare', tunnelId: 't1', tunnelName: 'swarmy', replicas: undefined, runTokenEnc: 'enc1' });
    const renamed = mergeIngressPatch(connected, { tunnel: { tunnelName: 'edge', replicas: 3 } }, {});
    expect(renamed.settings.tunnel).toMatchObject({ tunnelId: 't1', tunnelName: 'edge', replicas: 3, runTokenEnc: 'enc1' });
    expect(mergeIngressPatch(renamed, { tunnel: null }, {}).settings.tunnel).toBeUndefined();
  });

  it('DNS provider: set and clear touch only `acmeDns.byo` (the swarmy token secret stays)', () => {
    const start = doc({ acmeDns: { swarmySecret: 'swarmy-acme-dns-1' } });
    const set = mergeIngressPatch(start, { dnsProvider: { provider: 'cloudflare', apiToken: 't'.repeat(30) } }, { byo: BYO });
    expect(set.settings.acmeDns).toEqual({ swarmySecret: 'swarmy-acme-dns-1', byo: BYO });
    expect(JSON.stringify(set)).not.toContain('t'.repeat(30));
    expect(mergeIngressPatch(set, { dnsProvider: null }, {}).settings.acmeDns).toEqual({ swarmySecret: 'swarmy-acme-dns-1' });
  });

  it('never writes topology (it lands only after its swap deployed)', () => {
    expect(mergeIngressPatch(doc(), { topology: 'edge-per-node' }, {}).settings.topology).toBeUndefined();
  });
});

describe('ingressSettingsView', () => {
  it('defaults for an org that never saved anything', () => {
    const v = ingressSettingsView('org1', doc(), new Date(0));
    expect(v).toMatchObject({
      orgId: 'org1', driver: 'caddy', enabled: true, topology: 'controller', controllerImage: null, targetNodes: [],
      tls: { acmeEmail: null, onDemand: false, askUrl: null }, tunnel: null, dnsProvider: null,
    });
  });

  it('secrets read back as set / not set, never as values', () => {
    const v = ingressSettingsView('org1', doc({ tunnel: { tunnelId: 't1', runTokenEnc: 'SEALED' }, acmeDns: { byo: BYO } }), new Date(0));
    expect(v.tunnel).toEqual({ tunnelId: 't1', tunnelName: 'swarmy', replicas: 1, runTokenSet: true });
    expect(v.dnsProvider).toEqual({ provider: 'cloudflare', setAt: BYO.setAt, apiTokenSet: true });
    expect(JSON.stringify(v)).not.toContain('SEALED');
    expect(JSON.stringify(v)).not.toContain(BYO.secretName);
  });
});

describe('patch checks (validated before anything is written)', () => {
  const facts = currentFacts(doc());
  it('a tunnel needs its run token to connect, and a real one', () => {
    expect(() => assertIngressPatch({ tunnel: { replicas: 2 } }, facts, null)).toThrow(/run token first/);
    expect(() => assertIngressPatch({ tunnel: { runToken: 'x'.repeat(30) } }, facts, null)).toThrow(/tunnel token/);
    expect(() => assertIngressPatch({ tunnel: { runToken: 'x'.repeat(30) } }, facts, 't1')).not.toThrow();
  });
  it('on-demand TLS is judged on the settings after the patch', () => {
    expect(() => assertIngressPatch({ tls: { onDemand: true, askUrl: 'https://x/ask' } }, facts, null)).not.toThrow();
    const withEmail = currentFacts(doc({ globalOptions: { email: 'a@x.io', onDemandTls: true } }));
    expect(() => assertIngressPatch({ tls: { acmeEmail: null } }, withEmail, null)).toThrow(/ACME email or an ask/);
  });
  it('the schema is strict', () => {
    expect(() => parseIngressPatch({ tunnel: { runToken: 'x'.repeat(30), secret: 1 } })).toThrow(/invalid ingress settings/);
    expect(parseIngressPatch(undefined)).toEqual({});
  });
});

describe('ingressAudit — one row per write', () => {
  const f = { previousTopology: 'controller', tunnelId: 't1', byoSecretName: BYO.secretName };
  it('a single-field patch keeps its setter’s action', () => {
    expect(ingressAudit({ driver: 'caddy' }, f)).toEqual({ action: 'ingress.setDriver', metadata: { driver: 'caddy' } });
    expect(ingressAudit({ topology: 'edge-per-node' }, f).metadata).toEqual({ topology: 'edge-per-node', previous: 'controller' });
    expect(ingressAudit({ controllerImage: null }, f).action).toBe('ingress.clearControllerImage');
    expect(ingressAudit({ tunnel: null }, f).action).toBe('ingress.clearTunnel');
    expect(ingressAudit({ tls: { onDemand: true, askUrl: 'https://x' } }, f).action).toBe('ingress.setOnDemandTls');
  });
  it('a multi-field patch is ingress.updateSettings with every field, and no secret', () => {
    const a = ingressAudit({ enabled: true, dnsProvider: { provider: 'cloudflare', apiToken: 'SECRET'.repeat(5) } }, f);
    expect(a.action).toBe('ingress.updateSettings');
    expect(a.metadata).toEqual({
      fields: ['enabled', 'dnsProvider'],
      changes: { enabled: { enabled: true }, dnsProvider: { provider: 'cloudflare', secretName: BYO.secretName } },
    });
    expect(JSON.stringify(a)).not.toContain('SECRET');
  });
});
