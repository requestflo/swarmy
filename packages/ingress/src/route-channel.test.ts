import { describe, expect, it } from 'bun:test';
import { IngressConfigSchema, type IngressConfig } from './types';
import { channelWarnings, routeChannel, scopeToDriver } from './route-channel';
import { CaddyDriver } from './drivers/caddy';
import { CloudflaredDriver } from './drivers/cloudflared';

function cfg(domains: Record<string, unknown>[], over: Record<string, unknown> = {}): IngressConfig {
  return IngressConfigSchema.parse({ driver: 'caddy', orgId: 'org_1', domains, ...over });
}

const web = { domain: 'shop.example.com', service: 'shop_web', port: 3000 };
const admin = { domain: 'admin.example.com', service: 'shop_admin', port: 8080 };
const TUNNEL = { tunnelId: 't-1', runToken: 'tok' };

describe('routeChannel — declared exposure decides which edge serves a route', () => {
  it('undeclared / public → the org driver; tunnel → cloudflared; private / mesh → withheld', () => {
    expect(routeChannel({}, 'caddy')).toEqual({ driver: 'caddy' });
    expect(routeChannel({ expose: 'public' }, 'caddy')).toEqual({ driver: 'caddy' });
    expect(routeChannel({ expose: 'tunnel' }, 'caddy')).toEqual({ driver: 'cloudflared' });
    expect(routeChannel({ expose: 'private' }, 'caddy')).toEqual({ withheld: 'private' });
    expect(routeChannel({ expose: 'mesh' }, 'cloudflared')).toEqual({ withheld: 'mesh' });
  });
});

describe('scopeToDriver — the renderer only sees routes it may serve', () => {
  it('returns the same object when nothing is declared (byte-identical legacy render)', () => {
    const c = cfg([web, admin]);
    expect(scopeToDriver(c, 'caddy')).toBe(c);
  });

  it('drops private/mesh/tunnel routes from the public edge, and their www redirects', () => {
    const c = cfg(
      [web, { ...admin, expose: 'private' }, { ...admin, domain: 'vpn.example.com', expose: 'mesh' }],
      { hostRedirects: [{ from: 'www.admin.example.com', to: 'admin.example.com' }, { from: 'www.shop.example.com', to: 'shop.example.com' }] },
    );
    const scoped = scopeToDriver(c, 'caddy');
    expect(scoped.domains.map((d) => d.domain)).toEqual(['shop.example.com']);
    expect(scoped.hostRedirects?.map((r) => r.to)).toEqual(['shop.example.com']);
  });
});

describe('Caddy render consults swarmy.expose', () => {
  const caddy = new CaddyDriver();
  const file = (c: IngressConfig) => caddy.render(c).files[0]?.contents ?? '';

  it('a service declared private gets no public site block', () => {
    const out = file(cfg([web, { ...admin, expose: 'private' }]));
    expect(out).toContain('shop.example.com {');
    expect(out).not.toContain('admin.example.com');
  });

  it('a tunnel-only service never lands on the public edge', () => {
    const out = file(cfg([web, { ...admin, expose: 'tunnel' }]));
    expect(out).not.toContain('admin.example.com');
  });

  it('undeclared routes render exactly as before', () => {
    expect(file(cfg([web]))).toBe(file(cfg([{ ...web, expose: 'public' }])));
  });

  it('validate() says why a route is withheld (warning, never an error)', () => {
    const res = caddy.validate(cfg([web, { ...admin, expose: 'mesh' }, { ...admin, domain: 't.example.com', expose: 'tunnel' }]));
    expect(res.ok).toBe(true);
    const msgs = (res.warnings ?? []).map((w) => w.message).join('\n');
    expect(msgs).toContain('admin.example.com: the service is declared private or mesh-only');
    expect(msgs).toContain('t.example.com: tunnel-only');
    expect(msgs).toContain('unreachable');
  });
});

describe('cloudflared render consults swarmy.expose', () => {
  const cf = new CloudflaredDriver();
  it('serves tunnel + undeclared routes, never private/mesh ones', () => {
    const c = cfg([web, { ...admin, expose: 'tunnel' }, { ...admin, domain: 'db.example.com', expose: 'private' }], {
      driver: 'cloudflared',
      globalOptions: { tunnel: TUNNEL },
    });
    expect(cf.ingressRules(c).map((r) => r.hostname)).toEqual(['shop.example.com', 'admin.example.com', undefined]);
    expect(channelWarnings(c, 'cloudflared')).toHaveLength(1);
  });
});
