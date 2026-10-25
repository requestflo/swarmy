import { describe, expect, it } from 'bun:test';
import { addressCount, laneDomains, laneHosts, type LaneDomainSource } from './lane-domains-model';

const dom = (host: string, stack: string, extra: Partial<LaneDomainSource> = {}): LaneDomainSource => ({
  id: `${stack}:${host}`, host, stack, serviceId: 's1', serviceName: `${stack}_web`, targetPort: 3000, tls: 'auto',
  pathPrefix: null, protection: null, canaryPct: null, serving: true, edgeState: 'serving',
  status: { state: 'active' } as LaneDomainSource['status'], ...extra,
});

const ALL = [
  dom('shop.example.com', 'shop'),
  dom('web-shop-qa.1-2-3-4.sslip.io', 'shop-qa', { auto: true }),
  dom('qa.shop.dev', 'shop-qa', { status: { state: 'waiting_dns' } as LaneDomainSource['status'] }),
  dom('qa.shop.dev', 'shop-qa', { serviceName: 'shop-qa_api', pathPrefix: '/api', targetPort: 8080 }),
];

describe('laneDomains — each environment’s own addresses', () => {
  it('only its stack’s routes: its own domains first, then the automatic one', () => {
    expect(laneDomains('shop-qa', ALL)).toEqual([
      { host: 'qa.shop.dev', path: '', service: 'web', port: 3000, auto: false, word: 'Needs you', tone: 'warn' },
      { host: 'qa.shop.dev', path: '/api', service: 'api', port: 8080, auto: false, word: 'Online', tone: 'ok' },
      { host: 'web-shop-qa.1-2-3-4.sslip.io', path: '', service: 'web', port: 3000, auto: true, word: 'Online', tone: 'ok' },
    ]);
    expect(laneDomains('shop', ALL).map((d) => d.host)).toEqual(['shop.example.com']);
    expect(laneDomains('shop-staging', ALL)).toEqual([]);
  });

  it('names each host once for a removal, and counts addresses in words', () => {
    expect(laneHosts(laneDomains('shop-qa', ALL))).toEqual(['qa.shop.dev', 'web-shop-qa.1-2-3-4.sslip.io']);
    expect([0, 1, 3].map(addressCount)).toEqual(['No address yet', '1 address', '3 addresses']);
  });
});
