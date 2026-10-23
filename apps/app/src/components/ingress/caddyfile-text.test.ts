import { describe, expect, it } from 'bun:test';
import { caddyfileOf, onDemandOf, siteBlock } from './caddyfile-text';

const FILE = [
  '{',
  '  on_demand_tls {',
  '    ask https://swarmy.example.com/ingress/ask',
  '  }',
  '}',
  '',
  'shop.example.com {',
  '  reverse_proxy storefront_web:3000',
  '}',
  '',
  'http://plain.example.com {',
  '  reverse_proxy blog_ghost:2368',
  '}',
  '',
  'www.shop.example.com {',
  '  redir https://shop.example.com{uri} 308',
  '}',
].join('\n');

describe('caddyfile-text', () => {
  it('finds the Caddyfile inside the task first, then among written files', () => {
    expect(caddyfileOf({ files: [], localReload: { service: 'swarmy-ingress-caddy', file: { path: '/etc/caddy/Caddyfile', contents: 'a' } } })).toBe('a');
    expect(caddyfileOf({ files: [{ path: '/etc/caddy/Caddyfile', contents: 'b' }] })).toBe('b');
    expect(caddyfileOf({ files: [{ path: '/etc/cloudflared/config.yml', contents: 'c' }] })).toBeNull();
    expect(caddyfileOf(undefined)).toBeNull();
  });

  it('cuts out the site block for one host, including plain-http sites', () => {
    expect(siteBlock(FILE, 'shop.example.com')).toBe('shop.example.com {\n  reverse_proxy storefront_web:3000\n}');
    expect(siteBlock(FILE, 'PLAIN.example.com')).toContain('blog_ghost:2368');
    expect(siteBlock(FILE, 'missing.example.com')).toBeNull();
  });

  it('never mistakes the global options for a site', () => {
    expect(siteBlock(FILE, '{')).toBeNull();
  });

  it('reads on-demand TLS and its ask address from the global options', () => {
    expect(onDemandOf(FILE)).toEqual({ on: true, ask: 'https://swarmy.example.com/ingress/ask' });
    expect(onDemandOf('shop.example.com {\n  tls {\n    on_demand\n  }\n}')).toEqual({ on: false, ask: null });
    expect(onDemandOf(null)).toEqual({ on: false, ask: null });
  });
});
