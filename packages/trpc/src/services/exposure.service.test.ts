import { describe, expect, it } from 'bun:test';
import type { ExposedPortView, ExposureKind } from '@swarmy/core';
import {
  DEFAULT_EXPOSURE_RULES,
  classifyService,
  classifyServiceWithIntent,
  computeExposureDrift,
  countExposure,
  driftViolations,
  evaluateEstateRules,
  managedKindOf,
  parseExposureRules,
  type ClassifiableService,
  type ExposureDriftInput,
} from './exposure.service';

function svc(over: Partial<ClassifiableService> = {}): ClassifiableService {
  return {
    id: 'svc-1',
    name: 'web',
    stack: 'storefront',
    labels: {},
    ports: [],
    ...over,
  };
}

describe('managedKindOf — managed-data label prefixes', () => {
  it('detects each family by its label prefix', () => {
    expect(managedKindOf({ 'swarmy.db.cluster': 'main' })).toBe('db');
    expect(managedKindOf({ 'swarmy.cache.role': 'primary' })).toBe('cache');
    expect(managedKindOf({ 'swarmy.search.cluster': 'idx' })).toBe('search');
    expect(managedKindOf({ 'swarmy.vector.cluster': 'emb' })).toBe('vector');
  });

  it('returns null for plain apps and near-miss labels', () => {
    expect(managedKindOf({})).toBeNull();
    expect(managedKindOf({ 'com.docker.stack.namespace': 'x' })).toBeNull();
    expect(managedKindOf({ 'swarmy.database.x': '1' })).toBeNull();
  });
});

describe('classifyService — the audit classifier', () => {
  it('published port → public-port, with port details', () => {
    const row = classifyService(
      svc({ ports: [{ target: 8080, published: 443, protocol: 'tcp' }] }),
    );
    expect(row.exposure).toBe('public-port');
    expect(row.publishedPorts).toEqual([
      { target: 8080, published: 443, protocol: 'tcp', mode: null },
    ]);
    expect(row.details[0]).toContain(':443 → 8080/tcp');
  });

  it('unpublished (target-only) ports stay private', () => {
    const row = classifyService(svc({ ports: [{ target: 8080, protocol: 'tcp' }] }));
    expect(row.exposure).toBe('private');
    expect(row.publishedPorts).toEqual([]);
  });

  it('ingress routes label → public-domain with hostnames', () => {
    const row = classifyService(
      svc({
        labels: {
          'swarmy.ingress.routes': JSON.stringify([
            { host: 'app.example.com', port: 3000, tls: 'auto' },
          ]),
        },
      }),
    );
    expect(row.exposure).toBe('public-domain');
    expect(row.domains).toEqual(['app.example.com']);
  });

  it('managed-data labels → internal-managed when nothing is public', () => {
    const row = classifyService(svc({ labels: { 'swarmy.db.cluster': 'main' } }));
    expect(row.exposure).toBe('internal-managed');
    expect(row.managedKind).toBe('db');
    expect(row.details[0]).toContain('managed db');
  });

  it('a managed service WITH a published port is public-port (the violation case)', () => {
    const row = classifyService(
      svc({
        labels: { 'swarmy.db.cluster': 'main' },
        ports: [{ target: 5432, published: 5432, protocol: 'tcp' }],
      }),
    );
    expect(row.exposure).toBe('public-port');
    expect(row.managedKind).toBe('db');
  });

  it('malformed routes label degrades to private, never throws', () => {
    const row = classifyService(svc({ labels: { 'swarmy.ingress.routes': '{nope' } }));
    expect(row.exposure).toBe('private');
    expect(row.domains).toEqual([]);
  });
});

describe('parseExposureRules — codec + defaults', () => {
  it('empty json → the seeded defaults', () => {
    expect(parseExposureRules({}, false)).toEqual(DEFAULT_EXPOSURE_RULES);
  });

  it('partial json keeps defaults for the rest; enforce rides the row flag', () => {
    const rules = parseExposureRules({ noPublicUdp: false }, true);
    expect(rules.noPublicUdp).toBe(false);
    expect(rules.noPublicPortsOnManagedData).toBe(true);
    expect(rules.warnOnNewPublishedPorts).toBe(true);
    expect(rules.enforce).toBe(true);
  });

  it('non-boolean junk falls back to defaults', () => {
    expect(parseExposureRules({ noPublicUdp: 'yes' }, false).noPublicUdp).toBe(true);
    expect(parseExposureRules('garbage', false)).toEqual(DEFAULT_EXPOSURE_RULES);
  });
});

describe('evaluateEstateRules — current audit × rules', () => {
  const rules = { ...DEFAULT_EXPOSURE_RULES };

  it('managed data with a published port → block violation with a fix hint', () => {
    const rows = [
      classifyService(
        svc({
          name: 'postgres',
          stack: 'data',
          labels: { 'swarmy.db.cluster': 'main' },
          ports: [{ target: 5432, published: 5432, protocol: 'tcp' }],
        }),
      ),
    ];
    const violations = evaluateEstateRules(rows, rules);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe('exposure/no-public-ports-on-managed-data');
    expect(violations[0]!.severity).toBe('block');
    expect(violations[0]!.fixHint).toContain('Remove published port 5432');
  });

  it('public UDP → block violation per port', () => {
    const rows = [
      classifyService(svc({ ports: [{ target: 51820, published: 51820, protocol: 'udp' }] })),
    ];
    const violations = evaluateEstateRules(rows, rules);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe('exposure/no-public-udp');
  });

  it('disabled rules produce no violations', () => {
    const rows = [
      classifyService(
        svc({
          labels: { 'swarmy.cache.cluster': 'main' },
          ports: [{ target: 6379, published: 6379, protocol: 'tcp' }],
        }),
      ),
    ];
    expect(
      evaluateEstateRules(rows, { ...rules, noPublicPortsOnManagedData: false }),
    ).toHaveLength(0);
  });

  it('a healthy estate (domains + private) has no violations', () => {
    const rows = [
      classifyService(
        svc({
          labels: {
            'swarmy.ingress.routes': JSON.stringify([{ host: 'a.io', port: 80, tls: 'auto' }]),
          },
        }),
      ),
      classifyService(svc({ name: 'worker' })),
    ];
    expect(evaluateEstateRules(rows, rules)).toHaveLength(0);
  });
});

describe('computeExposureDrift — declared vs observed, all 4 modes', () => {
  const tcp = (published: number): ExposedPortView => ({
    target: published,
    published,
    protocol: 'tcp',
    mode: null,
  });
  const drift = (over: Partial<ExposureDriftInput> & Pick<ExposureDriftInput, 'declared'>) =>
    computeExposureDrift({
      observed: 'private' as ExposureKind,
      publishedPorts: [],
      domains: [],
      routeDrivers: [],
      ...over,
    });

  it('undeclared → never drifts, whatever is observed', () => {
    expect(
      drift({ declared: null, observed: 'public-port', publishedPorts: [tcp(80)] }),
    ).toBeNull();
    expect(drift({ declared: null, observed: 'public-domain', domains: ['a.io'] })).toBeNull();
  });

  it('private: conforming when observed private or internal-managed', () => {
    expect(drift({ declared: 'private', observed: 'private' })).toBeNull();
    expect(drift({ declared: 'private', observed: 'internal-managed' })).toBeNull();
  });

  it('private: observed public-port / public-domain → violation', () => {
    const byPort = drift({
      declared: 'private',
      observed: 'public-port',
      publishedPorts: [tcp(8080)],
    });
    expect(byPort?.level).toBe('violation');
    expect(byPort?.message).toContain(':8080/tcp');

    const byDomain = drift({
      declared: 'private',
      observed: 'public-domain',
      domains: ['app.example.com'],
      routeDrivers: ['caddy'],
    });
    expect(byDomain?.level).toBe('violation');
    expect(byDomain?.message).toContain('app.example.com');
  });

  it('public: conforming with a port or a domain', () => {
    expect(
      drift({ declared: 'public', observed: 'public-port', publishedPorts: [tcp(443)] }),
    ).toBeNull();
    expect(
      drift({
        declared: 'public',
        observed: 'public-domain',
        domains: ['a.io'],
        routeDrivers: ['caddy'],
      }),
    ).toBeNull();
  });

  it('public: no route and no port → warning (declared but unreachable)', () => {
    const d = drift({ declared: 'public', observed: 'private' });
    expect(d?.level).toBe('warning');
    expect(d?.message).toContain('unreachable');
  });

  it('tunnel: conforming when every route is cloudflared and nothing publishes', () => {
    expect(
      drift({
        declared: 'tunnel',
        observed: 'public-domain',
        domains: ['a.io'],
        routeDrivers: ['cloudflared'],
      }),
    ).toBeNull();
    expect(drift({ declared: 'tunnel', observed: 'private' })).toBeNull();
  });

  it('tunnel: a published port → violation (bypasses the tunnel)', () => {
    const d = drift({
      declared: 'tunnel',
      observed: 'public-port',
      publishedPorts: [tcp(80)],
    });
    expect(d?.level).toBe('violation');
    expect(d?.message).toContain('bypasses the tunnel');
  });

  it('tunnel: a route served by a non-cloudflared driver → violation', () => {
    const d = drift({
      declared: 'tunnel',
      observed: 'public-domain',
      domains: ['a.io'],
      routeDrivers: ['caddy', 'cloudflared'],
    });
    expect(d?.level).toBe('violation');
    expect(d?.message).toContain('caddy');
    expect(d?.message).toContain('not cloudflared');
  });

  it('mesh: conforming when nothing is public', () => {
    expect(drift({ declared: 'mesh', observed: 'private' })).toBeNull();
    expect(drift({ declared: 'mesh', observed: 'internal-managed' })).toBeNull();
  });

  it('mesh: any public port or route → violation', () => {
    expect(
      drift({ declared: 'mesh', observed: 'public-port', publishedPorts: [tcp(9000)] })?.level,
    ).toBe('violation');
    expect(
      drift({
        declared: 'mesh',
        observed: 'public-domain',
        domains: ['a.io'],
        routeDrivers: ['caddy'],
      })?.level,
    ).toBe('violation');
  });
});

describe('classifyServiceWithIntent — label → declared + drift on the row', () => {
  it('reads swarmy.expose and applies the org default driver to routes', () => {
    const declaredTunnel = classifyServiceWithIntent(
      svc({
        labels: {
          'swarmy.expose': 'tunnel',
          'swarmy.ingress.routes': JSON.stringify([{ host: 'a.io', port: 80, tls: 'auto' }]),
        },
      }),
      'caddy',
    );
    expect(declaredTunnel.declared).toBe('tunnel');
    expect(declaredTunnel.drift?.level).toBe('violation');

    const served = classifyServiceWithIntent(
      svc({
        labels: {
          'swarmy.expose': 'tunnel',
          'swarmy.ingress.routes': JSON.stringify([{ host: 'a.io', port: 80, tls: 'auto' }]),
        },
      }),
      'cloudflared',
    );
    expect(served.drift).toBeNull();
  });

  it('undeclared / junk label values → declared null, no drift', () => {
    expect(classifyServiceWithIntent(svc()).declared).toBeNull();
    const junk = classifyServiceWithIntent(svc({ labels: { 'swarmy.expose': 'internet' } }));
    expect(junk.declared).toBeNull();
    expect(junk.drift).toBeNull();
  });

  it('declared private + published port drifts as a violation', () => {
    const row = classifyServiceWithIntent(
      svc({
        labels: { 'swarmy.expose': 'private' },
        ports: [{ target: 80, published: 8080, protocol: 'tcp' }],
      }),
    );
    expect(row.exposure).toBe('public-port');
    expect(row.declared).toBe('private');
    expect(row.drift?.level).toBe('violation');
  });
});

describe('driftViolations — drift rows land in the violations feed', () => {
  it('violation drift → block, warning drift → warn, conforming rows skipped', () => {
    const rows = [
      classifyServiceWithIntent(
        svc({
          name: 'db',
          labels: { 'swarmy.expose': 'private' },
          ports: [{ target: 5432, published: 5432, protocol: 'tcp' }],
        }),
      ),
      classifyServiceWithIntent(svc({ name: 'site', labels: { 'swarmy.expose': 'public' } })),
      classifyServiceWithIntent(svc({ name: 'ok', labels: { 'swarmy.expose': 'mesh' } })),
      classifyServiceWithIntent(svc({ name: 'undeclared' })),
    ];
    const out = driftViolations(rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      rule: 'exposure/declared-drift',
      severity: 'block',
      serviceName: 'db',
    });
    expect(out[0]!.fixHint).toContain('"private"');
    expect(out[1]).toMatchObject({ severity: 'warn', serviceName: 'site' });
  });
});

describe('parseExposureRules — WS3 additive key', () => {
  it('enforceDeclaredIntent defaults ON and round-trips', () => {
    expect(parseExposureRules({}, false).enforceDeclaredIntent).toBe(true);
    expect(parseExposureRules({ enforceDeclaredIntent: false }, false).enforceDeclaredIntent).toBe(
      false,
    );
    expect(parseExposureRules({ enforceDeclaredIntent: 'no' }, false).enforceDeclaredIntent).toBe(
      true,
    );
  });
});

describe('countExposure — hero counts', () => {
  it('groups public (port+domain), private, managed', () => {
    const rows = [
      classifyService(svc({ ports: [{ target: 80, published: 80, protocol: 'tcp' }] })),
      classifyService(
        svc({
          labels: {
            'swarmy.ingress.routes': JSON.stringify([{ host: 'a.io', port: 80, tls: 'auto' }]),
          },
        }),
      ),
      classifyService(svc({ labels: { 'swarmy.db.cluster': 'x' } })),
      classifyService(svc({})),
    ];
    expect(countExposure(rows)).toEqual({ public: 2, private: 1, managed: 1 });
  });
});
