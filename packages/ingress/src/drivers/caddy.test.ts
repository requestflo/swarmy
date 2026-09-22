import { describe, expect, it } from 'bun:test';
import { IngressConfigSchema } from '../types';
import { CaddyDriver } from './caddy';

const driver = new CaddyDriver();

function validate(domains: Record<string, unknown>[], extraConfig: Record<string, unknown> = {}) {
  return driver.validate(
    IngressConfigSchema.parse({
      driver: 'caddy',
      orgId: 'org_1',
      domains,
      globalOptions: { extraConfig },
    }),
  );
}

function warningPaths(res: ReturnType<CaddyDriver['validate']>): string[] {
  return (res.warnings ?? []).map((w) => w.path);
}

const SWARMY_IMAGE = 'ghcr.io/example/caddy-swarmy:2';

describe('caddy validate — protection-layer plugin/config warnings', () => {
  it('cache on the stock image warns; on the swarmy build it does not', () => {
    const route = {
      domain: 'a.xyz.com',
      service: 'web',
      port: 3000,
      protection: { cache: { ttlSeconds: 60 } },
    };
    const stock = validate([route]);
    expect(stock.ok).toBe(true);
    expect(warningPaths(stock)).toContain('globalOptions.extraConfig.controllerImage');
    expect((stock.warnings ?? []).some((w) => w.message.includes('cache-handler'))).toBe(true);

    const custom = validate([route], { controllerImage: SWARMY_IMAGE });
    expect((custom.warnings ?? []).every((w) => !w.message.includes('cache-handler'))).toBe(true);
  });

  it('cache on a cold route warns that caching is skipped (and needs no image warning)', () => {
    const res = validate(
      [
        {
          domain: 'a.xyz.com',
          service: 'web',
          port: 3000,
          cold: { upstream: 'controller:3001', wakePath: '/_wake/web' },
          protection: { cache: { ttlSeconds: 60 } },
        },
      ],
      { controllerImage: SWARMY_IMAGE },
    );
    expect(res.ok).toBe(true);
    expect((res.warnings ?? []).some((w) => w.message.includes('scale-to-zero'))).toBe(true);
  });

  it('country rules WITHOUT geoipMmdbPath warn "not enforced"', () => {
    const res = validate(
      [{ domain: 'a.xyz.com', service: 'web', port: 3000, protection: { countryDeny: ['RU'] } }],
      { controllerImage: SWARMY_IMAGE },
    );
    expect(res.ok).toBe(true);
    expect(warningPaths(res)).toContain('globalOptions.extraConfig.geoipMmdbPath');
    expect((res.warnings ?? []).some((w) => w.message.includes('NOT enforced'))).toBe(true);
  });

  it('country rules WITH a path but the stock image warn about the swarmy build', () => {
    const res = validate(
      [{ domain: 'a.xyz.com', service: 'web', port: 3000, protection: { countryAllow: ['GB'] } }],
      { geoipMmdbPath: '/geoip/country.mmdb' },
    );
    expect(res.ok).toBe(true);
    expect((res.warnings ?? []).some((w) => w.message.includes('maxmind_geolocation'))).toBe(true);
  });

  it('country rules with a path AND the swarmy build produce no geo warnings', () => {
    const res = validate(
      [{ domain: 'a.xyz.com', service: 'web', port: 3000, protection: { countryAllow: ['GB'] } }],
      { geoipMmdbPath: '/geoip/country.mmdb', controllerImage: SWARMY_IMAGE },
    );
    expect(res.ok).toBe(true);
    expect(res.warnings ?? []).toEqual([]);
  });

  it('WAF-lite needs no plugin: no warnings on the stock image', () => {
    const res = validate([
      {
        domain: 'a.xyz.com',
        service: 'web',
        port: 3000,
        protection: { waf: { blockMethods: ['TRACE'] } },
      },
    ]);
    expect(res.ok).toBe(true);
    expect(res.warnings ?? []).toEqual([]);
  });
});

describe('caddy render/apply — replicated controller via in-task exec', () => {
  const config = IngressConfigSchema.parse({
    driver: 'caddy',
    orgId: 'org_1',
    domains: [{ domain: 'littleworld.example.test', service: 'littleworld_site', port: 80 }],
    globalOptions: { extraConfig: { applyVia: 'exec' } },
  });

  it('delivers the Caddyfile INTO the controller task, writing nothing on the agent host', () => {
    const r = driver.render(config);
    expect(r.files).toEqual([]);
    expect(r.reloadCommand).toBeUndefined();
    expect(r.adminApi).toBeUndefined();
    expect(r.localReload?.service).toBe('swarmy-ingress-caddy');
    expect(r.localReload?.file?.path).toBe('/etc/caddy/Caddyfile');
    expect(r.localReload?.file?.contents).toContain('littleworld.example.test');
    expect(r.localReload?.command).toEqual([
      'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile',
    ]);
  });

  it('zero running controller tasks is an apply ERROR, never "applied to 0 node(s)"', async () => {
    const sent: string[] = [];
    const dispatch = {
      resolveTargetNodes: async () => [],
      sendToNode: async (nodeId: string) => {
        sent.push(nodeId);
        return { nodeId, ok: true };
      },
      queryStatus: async () => ({ driver: 'caddy', healthy: true, activeDomains: [], certs: [] }),
    };
    await expect(driver.apply(driver.render(config), dispatch, config)).rejects.toThrow(
      /no running swarmy-ingress-caddy task/,
    );
    expect(sent).toEqual([]);
  });

  it('legacy default (no applyVia) still renders the host-file path unchanged', () => {
    const legacy = IngressConfigSchema.parse({ ...config, globalOptions: { extraConfig: {} } });
    const r = driver.render(legacy);
    expect(r.files[0]?.path).toBe('/etc/caddy/Caddyfile');
    expect(r.localReload).toBeUndefined();
  });
});
