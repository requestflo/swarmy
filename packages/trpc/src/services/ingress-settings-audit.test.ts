import { describe, expect, it } from 'bun:test';
import { ingressAudit } from './ingress-settings-audit';

const SECRET_NAME = 'swarmy-acme-dns-byo-abc';

describe('ingressAudit — one row per write', () => {
  const f = { previousTopology: 'controller', tunnelId: 't1', byoSecretName: SECRET_NAME };
  it('a single-field patch keeps its setter’s action', () => {
    expect(ingressAudit({ driver: 'caddy' }, f)).toEqual({ action: 'ingress.setDriver', metadata: { driver: 'caddy' } });
    expect(ingressAudit({ topology: 'edge-per-node' }, f).metadata).toEqual({ topology: 'edge-per-node', previous: 'controller' });
    expect(ingressAudit({ controllerImage: null }, f).action).toBe('ingress.clearControllerImage');
    expect(ingressAudit({ tunnel: null }, f).action).toBe('ingress.clearTunnel');
    expect(ingressAudit({ tls: { onDemand: true, askUrl: 'https://x' } }, f).action).toBe('ingress.setOnDemandTls');
    expect(ingressAudit({ geoip: { mode: 'off', path: '/x.mmdb' } }, f)).toEqual({ action: 'ingress.setEdgeGeoip', metadata: { mode: 'off' } });
    expect(ingressAudit({ autoAddressBase: 'NIP.io' }, f)).toEqual({ action: 'ingress.setAutoAddressBase', metadata: { base: 'nip.io' } });
    expect(ingressAudit({ autoAddressBase: null }, f).metadata).toEqual({ base: 'unset' });
  });
  it('a multi-field patch is ingress.updateSettings with every field, and no secret', () => {
    const a = ingressAudit({ enabled: true, dnsProvider: { provider: 'cloudflare', apiToken: 'SECRET'.repeat(5) } }, f);
    expect(a.action).toBe('ingress.updateSettings');
    expect(a.metadata).toEqual({
      fields: ['enabled', 'dnsProvider'],
      changes: { enabled: { enabled: true }, dnsProvider: { provider: 'cloudflare', secretName: SECRET_NAME } },
    });
    expect(JSON.stringify(a)).not.toContain('SECRET');
  });
});
