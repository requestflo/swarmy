import { describe, expect, it } from 'bun:test';
import { IngressConfigSchema, type IngressConfig } from './types';
import { channelWarnings, routeChannel, scopeToDriver, tunnelSideConfig } from './route-channel';
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
    expect(msgs).toContain('t.example.com: goes through the Cloudflare Tunnel');
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

describe('per-route driver override (route.driver)', () => {
  it('cloudflared / none move a route; caddy and removed drivers fall back to the org driver', () => {
    expect(routeChannel({ driver: 'cloudflared' }, 'caddy')).toEqual({ driver: 'cloudflared' });
    expect(routeChannel({ driver: 'none' }, 'caddy')).toEqual({ driver: 'none' });
    expect(routeChannel({ driver: 'caddy' }, 'cloudflared')).toEqual({ driver: 'cloudflared' });
    for (const gone of ['traefik', 'nginx', 'haproxy']) {
      expect(routeChannel({ driver: gone }, 'caddy')).toEqual({ driver: 'caddy' });
    }
  });

  it('declared exposure beats the override: a private service stays private whatever the route says', () => {
    expect(routeChannel({ expose: 'private', driver: 'cloudflared' }, 'caddy')).toEqual({ withheld: 'private' });
    expect(routeChannel({ expose: 'tunnel', driver: 'none' }, 'caddy')).toEqual({ driver: 'cloudflared' });
  });

  it('a legacy traefik override keeps rendering on Caddy (no outage after the driver removal)', () => {
    const out = new CaddyDriver().render(cfg([{ ...web, driver: 'traefik' }])).files[0]?.contents ?? '';
    expect(out).toContain('shop.example.com {');
  });

  it('a Caddy org renders tunnel-override routes on the tunnel side only', () => {
    const c = cfg([web, { ...admin, driver: 'cloudflared' }, { ...admin, domain: 'byo.example.com', driver: 'none' }], {
      globalOptions: { tunnel: TUNNEL },
    });
    const caddy = new CaddyDriver();
    const edge = caddy.render(c).files[0]?.contents ?? '';
    expect(edge).toContain('shop.example.com {');
    expect(edge).not.toContain('admin.example.com');
    expect(edge).not.toContain('byo.example.com');

    const side = tunnelSideConfig(c);
    expect(side).toMatchObject({ driver: 'cloudflared', defaultDriver: 'caddy' });
    const cf = new CloudflaredDriver();
    expect(cf.ingressRules(side!).map((r) => r.hostname)).toEqual(['admin.example.com', undefined]);
    expect(cf.render(side!).connector?.kind).toBe('cloudflared');
    const msgs = (caddy.validate(c).warnings ?? []).map((w) => w.message).join('\n');
    expect(msgs).toContain('admin.example.com: goes through the Cloudflare Tunnel');
    expect(msgs).toContain('the tunnel does.');
  });

  it('no tunnel side without a tunnel, without tunnel routes, or when the tunnel IS the org edge', () => {
    expect(tunnelSideConfig(cfg([{ ...admin, driver: 'cloudflared' }]))).toBeNull();
    expect(tunnelSideConfig(cfg([web], { globalOptions: { tunnel: TUNNEL } }))).toBeNull();
    const tunnelOrg = cfg([{ ...admin, driver: 'cloudflared' }], { driver: 'cloudflared', globalOptions: { tunnel: TUNNEL } });
    expect(tunnelSideConfig(tunnelOrg)).toBeNull();
  });
});
