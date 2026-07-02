import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_EXPOSURE_RULES,
  classifyService,
  countExposure,
  evaluateEstateRules,
  managedKindOf,
  parseExposureRules,
  type ClassifiableService,
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
