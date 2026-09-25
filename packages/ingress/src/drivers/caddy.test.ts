import { describe, expect, it } from 'bun:test';
import { IngressConfigSchema } from '../types';
import { CaddyDriver, isStockCaddyImage, SWARMY_CADDY_IMAGE } from './caddy';

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

  it('RUM on the stock image warns (swarmy_rum is swarmy-build only); on the swarmy build it does not', () => {
    const route = {
      domain: 'a.xyz.com',
      service: 'web',
      port: 3000,
      rum: { upstream: 'swarmy_controller:3021', token: 'v1.a.b' },
    };
    expect((validate([route]).warnings ?? []).some((w) => w.message.includes('swarmy_rum'))).toBe(true);
    expect((validate([route], { controllerImage: SWARMY_IMAGE }).warnings ?? []).some((w) => w.message.includes('swarmy_rum'))).toBe(false);
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

describe('caddy render/apply — edge-per-node via in-task exec on EVERY edge node', () => {
  const route = (domain: string) => ({
    domain,
    service: 'web',
    port: 80,
    regionUpstreams: [
      { region: 'lon', service: 'web-lon', port: 80 },
      { region: 'nyc', service: 'web-nyc', port: 80 },
    ],
  });
  const config = IngressConfigSchema.parse({
    driver: 'caddy',
    orgId: 'org_1',
    domains: [route('app.example.test')],
    controllerVhosts: [
      { domain: 'swarmy.example.test', upstream: 'swarmy_controller:3021', targetPath: '/', kind: 'dashboard', tls: 'auto' },
    ],
    globalOptions: { extraConfig: { applyVia: 'local' } },
  });

  it('writes the Caddyfile INSIDE the local edge task — no host file, no admin API', () => {
    const r = driver.render(config);
    expect(r.files).toEqual([]);
    expect(r.adminApi).toBeUndefined();
    expect(r.reloadCommand).toBeUndefined();
    expect(r.localReload?.service).toBe('swarmy-ingress-caddy');
    expect(r.localReload?.file?.path).toBe('/etc/caddy/Caddyfile');
    expect(r.localReload?.command).toEqual([
      'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile',
    ]);
  });

  it('fans a per-node, region-ordered render out to each edge node, dashboard vhost on all', async () => {
    const sent = new Map<string, string>();
    const dispatch = {
      resolveTargetNodes: async () => ['n-lon', 'n-nyc'],
      resolveTargets: async () => [
        { nodeId: 'n-lon', region: 'lon' },
        { nodeId: 'n-nyc', region: 'nyc' },
      ],
      sendToNode: async (nodeId: string, r: { localReload?: { file?: { contents: string } } }) => {
        sent.set(nodeId, r.localReload?.file?.contents ?? '');
        return { nodeId, ok: true };
      },
      queryStatus: async () => ({ driver: 'caddy', healthy: true, activeDomains: [], certs: [] }),
    };
    const status = await driver.apply(driver.render(config), dispatch as never, config);
    expect(status.message).toBe('applied to 2 node(s)');
    expect([...sent.keys()].sort()).toEqual(['n-lon', 'n-nyc']);
    for (const body of sent.values()) expect(body).toContain('swarmy.example.test');
    const lon = sent.get('n-lon')!;
    const nyc = sent.get('n-nyc')!;
    expect(lon.indexOf('web-lon')).toBeLessThan(lon.indexOf('web-nyc'));
    expect(nyc.indexOf('web-nyc')).toBeLessThan(nyc.indexOf('web-lon'));
  });

  it('warns (non-blocking) when no shared cert storage backs the edge', () => {
    const res = driver.validate(config);
    expect(res.ok).toBe(true);
    expect(warningPaths(res)).toContain('globalOptions.certStorage');
  });
});

describe('caddy edge certificate storage (storage swarmy, replica s3)', () => {
  const certStorage = {
    kind: 's3' as const,
    endpoint: 'http://swarmy-garage:3900',
    bucket: 'swarmy-edge-certs',
    region: 'garage',
    prefix: 'caddy/org_1',
  };
  const config = (extraConfig: Record<string, unknown>) =>
    IngressConfigSchema.parse({
      driver: 'caddy',
      orgId: 'org_1',
      domains: [{ domain: 'app.example.test', service: 'web', port: 80 }],
      globalOptions: { certStorage, extraConfig },
    });

  it('renders storage swarmy with the s3 replica, coordinates only — no credential directives', () => {
    const body = driver.render(config({ applyVia: 'local', controllerImage: SWARMY_IMAGE })).localReload!.file!
      .contents;
    const start = body.indexOf('  storage swarmy {');
    const block = body.slice(start, body.indexOf('\n  }\n', start) + 4);
    expect(block).toBe(
      [
        '  storage swarmy {',
        '    replica s3 {',
        '      endpoint http://swarmy-garage:3900',
        '      bucket swarmy-edge-certs',
        '      region garage',
        '      prefix caddy/org_1',
        '      use_path_style true',
        '    }',
        '  }',
      ].join('\n'),
    );
    expect(body).not.toMatch(/access_key|secret_key|encryption_key|password/);
  });

  it('an encrypted store imports its key file — the key itself is never rendered', () => {
    const body = driver
      .render(
        IngressConfigSchema.parse({
          driver: 'caddy',
          orgId: 'org_1',
          domains: [{ domain: 'app.example.test', service: 'web', port: 80 }],
          globalOptions: {
            certStorage: { ...certStorage, prefix: 'caddy-enc/org_1', encryptionKeyFile: '/run/secrets/swarmy-edge-certs-enc' },
            extraConfig: { applyVia: 'local', controllerImage: SWARMY_IMAGE },
          },
        }),
      )
      .localReload!.file!.contents;
    expect(body).toContain(
      '      prefix caddy-enc/org_1\n      import /run/secrets/swarmy-edge-certs-enc\n      use_path_style true',
    );
    expect(body).not.toMatch(/encryption_key/);
  });

  it('the schema cannot even carry credentials', () => {
    const parsed = IngressConfigSchema.parse({
      driver: 'caddy',
      orgId: 'org_1',
      globalOptions: { certStorage: { ...certStorage, secretKey: 'nope', accessKey: 'nope' } },
    });
    expect(Object.keys(parsed.globalOptions.certStorage!)).not.toContain('secretKey');
    expect(driver.render(parsed).files.map((f) => f.contents).join('')).not.toContain('nope');
  });

  it('no storage block (local file storage) without certStorage', () => {
    const plain = IngressConfigSchema.parse({ driver: 'caddy', orgId: 'org_1', globalOptions: {} });
    expect(driver.render(plain).files.map((f) => f.contents).join('')).not.toContain('storage');
  });

  it('hard-errors when shared storage meets a stock caddy image', () => {
    const res = driver.validate(config({ applyVia: 'local', controllerImage: 'caddy:2-alpine' }));
    expect(res.ok).toBe(false);
    expect(res.ok ? [] : res.errors.map((e) => e.message).join(' ')).toContain('certmagic-s3');
    expect(driver.validate(config({ applyVia: 'local', controllerImage: SWARMY_IMAGE })).ok).toBe(true);
  });

  it('edge-per-node WITH shared storage does not carry the per-node issuance warning', () => {
    const res = driver.validate(config({ applyVia: 'local', controllerImage: SWARMY_IMAGE }));
    expect(warningPaths(res)).not.toContain('globalOptions.certStorage');
  });
});

describe('isStockCaddyImage', () => {
  it('recognises stock caddy references (and treats unknown as stock)', () => {
    for (const img of ['', 'caddy', 'caddy:2-alpine', 'caddy:2.11.4', 'docker.io/library/caddy:2', 'caddy@sha256:abc']) {
      expect(isStockCaddyImage(img)).toBe(true);
    }
  });
  it('swarmy build and custom registries are not stock', () => {
    for (const img of [SWARMY_CADDY_IMAGE, 'ghcr.io/example/caddy-swarmy:2', 'registry.local:5000/caddy:2']) {
      expect(isStockCaddyImage(img)).toBe(false);
    }
  });
});
