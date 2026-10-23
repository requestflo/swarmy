import { describe, expect, test } from 'bun:test';
import { caddyfileOf, daysLeft, renewsIn, siteBlock, storedIn } from './cert-model';

const NOW = Date.parse('2026-10-23T12:00:00Z');

describe('certificate facts', () => {
  test('days left and renewal (30 days before expiry)', () => {
    expect(daysLeft('2027-01-01T12:00:00Z', NOW)).toBe(70);
    expect(renewsIn('2027-01-01T12:00:00Z', NOW)).toBe(40);
    expect(renewsIn('2026-11-01T12:00:00Z', NOW)).toBe(0);
    expect(daysLeft(null, NOW)).toBeNull();
  });

  test('where it is stored', () => {
    expect(storedIn({ mode: 'shared', bucket: 'swarmy-edge-certs' })).toBe('swarmy-edge-certs');
    expect(storedIn({ mode: 'local', bucket: null })).toBe('each front door’s own disk');
    expect(storedIn(undefined)).toBeNull();
  });

  test('one host’s site block from the rendered Caddyfile', () => {
    const cf = [
      '{', '\temail ops@x.dev', '}', '',
      'www.shop.northwind.dev {', '  redir https://shop.northwind.dev{uri} 308', '}', '',
      'shop.northwind.dev {', '  @bots_shop header_regexp User-Agent (?i)(bot)', '  reverse_proxy web:3000 {', '    lb_policy first', '  }', '}', '',
      'http://api.northwind.dev {', '  reverse_proxy api:8080', '}',
    ].join('\n');
    expect(siteBlock(cf, 'shop.northwind.dev')).toBe(['shop.northwind.dev {', '  @bots_shop header_regexp User-Agent (?i)(bot)', '  reverse_proxy web:3000 {', '    lb_policy first', '  }', '}'].join('\n'));
    expect(siteBlock(cf, 'api.northwind.dev')).toBe('http://api.northwind.dev {\n  reverse_proxy api:8080\n}');
    expect(siteBlock(cf, 'northwind.dev')).toBeNull();
  });

  test('the Caddyfile is a file or written inside the task', () => {
    expect(caddyfileOf({ files: [{ path: '/etc/caddy/Caddyfile', contents: 'a' }] })).toBe('a');
    expect(caddyfileOf({ files: [], localReload: { file: { path: '/etc/caddy/Caddyfile', contents: 'b' } } })).toBe('b');
    expect(caddyfileOf({ files: [{ path: '/etc/cloudflared/config.yml', contents: 'c' }] })).toBeNull();
  });
});
