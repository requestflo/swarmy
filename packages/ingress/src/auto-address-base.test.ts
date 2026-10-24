import { describe, expect, it } from 'bun:test';
import { DEFAULT_AUTO_ADDRESS_BASE, autoAddressBaseFor, normalizeAutoAddressBase } from './auto-address-base';
import { buildCaddyfile, isPrivateHost } from './render/caddyfile';
import { IngressConfigSchema } from './types';

const BASE = '203-0-113-10.sslip.io';

describe('autoAddressBaseFor — sslip.io stays the default', () => {
  it('reuses the installer dashboard base (dashed or dotted)', () => {
    expect(autoAddressBaseFor({ dashboardDomain: 'swarmy.203-0-113-10.sslip.io', edgeIps: ['198.51.100.1'] })).toBe(BASE);
    expect(autoAddressBaseFor({ dashboardDomain: 'swarmy.203.0.113.10.nip.io', edgeIps: [] })).toBe('203-0-113-10.nip.io');
  });
  it('falls back to the first edge IPv4, then IPv6; null with no IP', () => {
    expect(autoAddressBaseFor({ dashboardDomain: 'swarmy.acme.com', edgeIps: ['2001:db8::1', '203.0.113.10'] })).toBe(BASE);
    expect(autoAddressBaseFor({ edgeIps: ['2001:db8::1'] })).toBe('2001-db8--1.sslip.io');
    expect(autoAddressBaseFor({ edgeIps: [] })).toBeNull();
    expect(DEFAULT_AUTO_ADDRESS_BASE).toBe('sslip.io');
  });
});

describe('autoAddressBaseFor — a configured base (SWARMY_AUTO_ADDRESS_BASE / org setting)', () => {
  it('forms edge-IP names under the configured base', () => {
    expect(autoAddressBaseFor({ edgeIps: ['203.0.113.10'], base: 'ip.acme.net' })).toBe('203-0-113-10.ip.acme.net');
    expect(autoAddressBaseFor({ edgeIps: ['2001:db8::1'], base: 'nip.io' })).toBe('2001-db8--1.nip.io');
  });
  it('keeps the dashboard IP but moves it onto the configured base', () => {
    expect(autoAddressBaseFor({ dashboardDomain: 'swarmy.203-0-113-10.sslip.io', edgeIps: ['198.51.100.1'], base: 'ip.acme.net' })).toBe(
      '203-0-113-10.ip.acme.net',
    );
    expect(autoAddressBaseFor({ dashboardDomain: 'swarmy.203-0-113-10.ip.acme.net', edgeIps: [], base: 'ip.acme.net' })).toBe(
      '203-0-113-10.ip.acme.net',
    );
  });
  it('an unusable base is ignored, never rendered', () => {
    expect(autoAddressBaseFor({ edgeIps: ['203.0.113.10'], base: 'not a domain' })).toBe(BASE);
    expect(autoAddressBaseFor({ edgeIps: ['203.0.113.10'], base: '' })).toBe(BASE);
  });
});

describe('normalizeAutoAddressBase', () => {
  it('lowercases, trims dots and a leading wildcard; rejects non-names', () => {
    expect(normalizeAutoAddressBase('  IP.Acme.NET. ')).toBe('ip.acme.net');
    expect(normalizeAutoAddressBase('*.nip.io')).toBe('nip.io');
    expect(normalizeAutoAddressBase('localhost')).toBeNull();
    expect(normalizeAutoAddressBase('a b.io')).toBeNull();
    expect(normalizeAutoAddressBase(null)).toBeNull();
  });
});

describe('isPrivateHost — private-IP names under a configured base get the local CA', () => {
  it('only when the base is passed in', () => {
    expect(isPrivateHost('web-shop.192-168-1-5.ip.acme.net')).toBe(false);
    expect(isPrivateHost('web-shop.192-168-1-5.ip.acme.net', ['ip.acme.net'])).toBe(true);
    expect(isPrivateHost('web-shop.203-0-113-10.ip.acme.net', ['ip.acme.net'])).toBe(false);
    expect(isPrivateHost('web-shop.192-168-1-5.sslip.io')).toBe(true);
  });

  it('the Caddy render reads the base from extraConfig.autoAddressBase', () => {
    const render = (extraConfig: Record<string, unknown>) =>
      buildCaddyfile(
        IngressConfigSchema.parse({
          driver: 'caddy',
          orgId: 'org_1',
          domains: [{ domain: 'web-shop.192-168-1-5.ip.acme.net', service: 'shop_web', port: 3000 }],
          globalOptions: { extraConfig },
        }),
      );
    expect(render({ autoAddressBase: 'ip.acme.net' })).toContain('  tls internal');
    expect(render({})).not.toContain('tls internal');
  });
});
