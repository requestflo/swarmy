import { describe, expect, test } from 'bun:test';
import type { DnsRecordView, DnsViewRow } from './geo-types';
import { mergeRecords, relName } from './zone-records-model';

const eps = [
  { region: 'us-east', ip: '203.0.113.10', healthy: true },
  { region: 'us-west', ip: '203.0.113.40', healthy: false },
];
const row = (host: string, source: string): DnsViewRow => ({ host, zone: 'northwind.dev', source, endpoints: eps, healthyCount: 1 });
const names: Record<string, string> = { '203.0.113.10': 'mgr-1', '203.0.113.40': 'wkr-3' };
const nameOf = (ip: string): string => names[ip] ?? ip;

describe('zone records', () => {
  test('relative names', () => {
    expect(relName('northwind.dev', 'northwind.dev')).toBe('@');
    expect(relName('shop.northwind.dev', 'northwind.dev')).toBe('shop');
    expect(relName('other.io', 'northwind.dev')).toBe('other.io');
  });

  test('automatic records group apex/www and the routed addresses, then yours', () => {
    const view = [row('northwind.dev', 'apex'), row('www.northwind.dev', 'www'), ...['a', 'b', 'c', 'd', 'e'].map((h) => row(`${h}.northwind.dev`, 'route')), { ...row('x.other.io', 'route'), zone: 'other.io' }];
    const manual: DnsRecordView[] = [
      { id: 'r2', zoneId: 'z', name: '@', type: 'TXT', value: 'v=spf1 ~all', ttl: null, priority: null },
      { id: 'r1', zoneId: 'z', name: '@', type: 'MX', value: 'mx.example.com', ttl: 3600, priority: 10 },
    ];
    const lines = mergeRecords('northwind.dev', view, manual, nameOf);
    expect(lines.map((l) => [l.type, l.name, l.source])).toEqual([
      ['A', '@ · www', 'automatic'],
      ['A', 'a b c +2', 'automatic'],
      ['MX', '@', 'you'],
      ['TXT', '@', 'you'],
    ]);
    expect(lines[0]!.value).toBe('nearest of mgr-1 · wkr-3 out');
    expect(lines[2]!.value).toBe('10 mx.example.com');
    expect(lines[2]!.id).toBe('r1');
  });

  test('no healthy endpoint says so instead of an empty answer', () => {
    const down = [{ ...row('shop.northwind.dev', 'route'), endpoints: [eps[1]!], healthyCount: 0 }];
    expect(mergeRecords('northwind.dev', down, [], nameOf)[0]!.value).toBe('all of wkr-3 (none healthy)');
  });
});
