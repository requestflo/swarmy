import { describe, expect, it } from 'bun:test';
import { buildCaddyfile } from './render/caddyfile';
import type { IngressConfig } from './types';
import { companionHost, expandWww, hostsWithCompanions, wwwPair, type WwwMode } from './www';

const route = (domain: string, extra: Partial<IngressConfig['domains'][number]> = {}) => ({
  domain,
  pathPrefix: '/',
  service: 'shop_web',
  port: 3000,
  tls: 'auto' as const,
  stripPathPrefix: false,
  middlewares: [],
  ...extra,
});

const modes = (m: Record<string, WwwMode>) => new Map(Object.entries(m));

describe('wwwPair / companionHost', () => {
  it('pairs apex and www both ways', () => {
    expect(wwwPair('acme.com')).toEqual({ apex: 'acme.com', www: 'www.acme.com' });
    expect(wwwPair('WWW.Acme.com.')).toEqual({ apex: 'acme.com', www: 'www.acme.com' });
    expect(companionHost('acme.com')).toBe('www.acme.com');
    expect(companionHost('www.acme.com')).toBe('acme.com');
    expect(companionHost('app.acme.com')).toBe('www.app.acme.com');
  });
  it('has no companion for wildcards, IPs and single labels', () => {
    expect(companionHost('*.acme.com')).toBeNull();
    expect(companionHost('10.0.0.1')).toBeNull();
    expect(companionHost('localhost')).toBeNull();
    expect(companionHost('www.com')).toBeNull(); // bare-TLD apex: no pairing
  });
  it('hostsWithCompanions adds companions only for toggled hosts', () => {
    expect(hostsWithCompanions([{ host: 'a.com', www: 'serve-both' }, { host: 'b.com' }]).sort()).toEqual([
      'a.com',
      'b.com',
      'www.a.com',
    ]);
  });
});

describe('expandWww', () => {
  it('passes through untouched with no toggles', () => {
    const rs = [route('acme.com')];
    expect(expandWww(rs, new Map())).toEqual({ routes: rs, redirects: [] });
  });

  it('redirect-www-to-apex: serve apex, redirect www', () => {
    const out = expandWww([route('acme.com')], modes({ 'acme.com': 'redirect-www-to-apex' }));
    expect(out.routes.map((r) => r.domain)).toEqual(['acme.com']);
    expect(out.redirects).toEqual([{ from: 'www.acme.com', to: 'acme.com', tls: 'auto' }]);
  });

  it('redirect-apex-to-www: moves every path route of the host onto www', () => {
    const out = expandWww(
      [route('acme.com'), route('acme.com', { pathPrefix: '/api', service: 'shop_api' })],
      modes({ 'acme.com': 'redirect-apex-to-www' }),
    );
    expect(out.routes.map((r) => `${r.domain}${r.pathPrefix}`)).toEqual(['www.acme.com/', 'www.acme.com/api']);
    expect(out.redirects).toEqual([{ from: 'acme.com', to: 'www.acme.com', tls: 'auto' }]);
  });

  it('works when the route host is the www name', () => {
    const out = expandWww([route('www.acme.com')], modes({ 'www.acme.com': 'redirect-www-to-apex' }));
    expect(out.routes.map((r) => r.domain)).toEqual(['acme.com']);
    expect(out.redirects).toEqual([{ from: 'www.acme.com', to: 'acme.com', tls: 'auto' }]);
  });

  it('serve-both clones routes onto the companion', () => {
    const out = expandWww([route('acme.com', { tls: 'off' })], modes({ 'acme.com': 'serve-both' }));
    expect(out.routes.map((r) => r.domain)).toEqual(['acme.com', 'www.acme.com']);
    expect(out.redirects).toEqual([]);
  });

  it('an explicit route on the companion wins over the toggle', () => {
    const out = expandWww(
      [route('acme.com'), route('www.acme.com', { service: 'blog' })],
      modes({ 'acme.com': 'redirect-www-to-apex' }),
    );
    expect(out.routes.map((r) => `${r.domain}:${r.service}`)).toEqual(['acme.com:shop_web', 'www.acme.com:blog']);
    expect(out.redirects).toEqual([]);
  });

  it('keeps routes in place when the canonical host is claimed elsewhere', () => {
    const out = expandWww(
      [route('acme.com'), route('www.acme.com', { service: 'blog' })],
      modes({ 'acme.com': 'redirect-apex-to-www' }),
    );
    expect(out.routes.map((r) => `${r.domain}:${r.service}`)).toEqual(['acme.com:shop_web', 'www.acme.com:blog']);
    expect(out.redirects).toEqual([]);
  });
});

describe('caddyfile host redirects (golden)', () => {
  const base = (extra: Partial<IngressConfig> = {}): IngressConfig => ({
    driver: 'caddy',
    enabled: true,
    orgId: 'o1',
    targetNodes: [],
    domains: [route('acme.com')],
    controllerVhosts: [],
    globalOptions: { extraConfig: {} } as IngressConfig['globalOptions'],
    ...extra,
  });

  it('is byte-identical with no redirects', () => {
    expect(buildCaddyfile(base({ hostRedirects: [] }))).toBe(buildCaddyfile(base()));
  });

  it('renders a 308 site for the redirect host', () => {
    const out = buildCaddyfile(base({ hostRedirects: [{ from: 'www.acme.com', to: 'acme.com', tls: 'auto' }] }));
    expect(out).toContain(['www.acme.com {', '  # swarmy www redirect', '  redir https://acme.com{uri} 308', '}'].join('\n'));
  });

  it('plain-http redirect for tls off, on-demand tls when enabled', () => {
    const off = buildCaddyfile(base({ hostRedirects: [{ from: 'www.acme.com', to: 'acme.com', tls: 'off' }] }));
    expect(off).toContain('http://www.acme.com {\n  # swarmy www redirect\n  redir http://acme.com{uri} 308\n}');
    const od = buildCaddyfile(
      base({
        hostRedirects: [{ from: 'www.acme.com', to: 'acme.com', tls: 'auto' }],
        globalOptions: { extraConfig: {}, onDemandTls: true } as IngressConfig['globalOptions'],
      }),
    );
    expect(od).toContain('www.acme.com {\n  # swarmy www redirect\n  tls {\n    on_demand\n  }\n  redir https://acme.com{uri} 308\n}');
  });

  it('skips a redirect whose host already has a route', () => {
    const out = buildCaddyfile(base({ hostRedirects: [{ from: 'acme.com', to: 'www.acme.com', tls: 'auto' }] }));
    expect(out).not.toContain('swarmy www redirect');
  });
});
