import { describe, expect, it } from 'bun:test';
import {
  decideDeclaredIntentAdmission,
  decideExposureAdmission,
  specFacts,
  type LiveExposureFacts,
  type SpecExposureFacts,
} from './admission-exposure';
import { DEFAULT_EXPOSURE_RULES } from './exposure.service';

const ENFORCED = { ...DEFAULT_EXPOSURE_RULES, enforce: true };

const noLive: LiveExposureFacts = {
  managedKindFor: () => null,
  publishedKeysFor: () => new Set<string>(),
};

function spec(over: Partial<SpecExposureFacts> = {}): SpecExposureFacts {
  return { name: 'web', labels: {}, ports: [], ...over };
}

describe('specFacts — coercion of unknown intent specs', () => {
  it('keeps named specs and defaults missing labels/ports', () => {
    const facts = specFacts([
      { name: 'a', image: 'x' },
      { name: 'b', labels: { k: 'v' }, ports: [{ target: 80, published: 80 }] },
      { image: 'no-name' },
      null,
      'junk',
    ]);
    expect(facts.map((f) => f.name)).toEqual(['a', 'b']);
    expect(facts[0]!.labels).toEqual({});
    expect(facts[1]!.ports).toHaveLength(1);
  });
});

describe('decideExposureAdmission', () => {
  it('enforce OFF → estate rules stay advisory (no violations)', () => {
    const violations = decideExposureAdmission({
      rules: { ...DEFAULT_EXPOSURE_RULES, enforce: false },
      specs: [
        spec({
          labels: { 'swarmy.db.cluster': 'main' },
          ports: [{ target: 5432, published: 5432, protocol: 'tcp' }],
        }),
      ],
      live: noLive,
    });
    expect(violations).toEqual([]);
  });

  it('managed-data labels on the SPEC + published port → block', () => {
    const violations = decideExposureAdmission({
      rules: ENFORCED,
      specs: [
        spec({
          name: 'postgres',
          labels: { 'swarmy.db.cluster': 'main' },
          ports: [{ target: 5432, published: 5432, protocol: 'tcp' }],
        }),
      ],
      live: noLive,
    });
    const block = violations.find((v) => v.rule === 'exposure/no-public-ports-on-managed-data');
    expect(block?.severity).toBe('block');
    expect(block?.resource).toBe('postgres');
  });

  it('managed-data known only from the LIVE service → still blocks', () => {
    const violations = decideExposureAdmission({
      rules: ENFORCED,
      specs: [spec({ name: 'redis', ports: [{ target: 6379, published: 6379 }] })],
      live: { ...noLive, managedKindFor: (n) => (n === 'redis' ? 'cache' : null) },
    });
    expect(
      violations.some((v) => v.rule === 'exposure/no-public-ports-on-managed-data'),
    ).toBe(true);
  });

  it('published UDP → block; tcp does not trip the udp rule', () => {
    const violations = decideExposureAdmission({
      rules: { ...ENFORCED, warnOnNewPublishedPorts: false },
      specs: [
        spec({
          ports: [
            { target: 51820, published: 51820, protocol: 'udp' },
            { target: 80, published: 80, protocol: 'tcp' },
          ],
        }),
      ],
      live: noLive,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe('exposure/no-public-udp');
  });

  it('new published port vs live → warn; already-published ports stay quiet', () => {
    const live: LiveExposureFacts = {
      ...noLive,
      publishedKeysFor: () => new Set(['80/tcp']),
    };
    const quiet = decideExposureAdmission({
      rules: ENFORCED,
      specs: [spec({ ports: [{ target: 8080, published: 80, protocol: 'tcp' }] })],
      live,
    });
    expect(quiet).toEqual([]);

    const noisy = decideExposureAdmission({
      rules: ENFORCED,
      specs: [
        spec({
          ports: [
            { target: 8080, published: 80, protocol: 'tcp' },
            { target: 9000, published: 9000, protocol: 'tcp' },
          ],
        }),
      ],
      live,
    });
    expect(noisy).toHaveLength(1);
    expect(noisy[0]!.rule).toBe('exposure/new-published-port');
    expect(noisy[0]!.severity).toBe('warn');
    expect(noisy[0]!.message).toContain('9000/tcp');
  });

  it('declared-intent violations surface even with enforce OFF (per-service opt-in)', () => {
    const violations = decideExposureAdmission({
      rules: { ...DEFAULT_EXPOSURE_RULES, enforce: false },
      specs: [
        spec({
          labels: { 'swarmy.expose': 'private' },
          ports: [{ target: 80, published: 8080, protocol: 'tcp' }],
        }),
      ],
      live: noLive,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe('exposure/intent-private-published-port');
  });

  it('enforceDeclaredIntent OFF silences the intent checks', () => {
    const violations = decideExposureAdmission({
      rules: { ...DEFAULT_EXPOSURE_RULES, enforce: false, enforceDeclaredIntent: false },
      specs: [
        spec({
          labels: { 'swarmy.expose': 'private' },
          ports: [{ target: 80, published: 8080, protocol: 'tcp' }],
        }),
      ],
      live: noLive,
    });
    expect(violations).toEqual([]);
  });

  it('intent + estate rules both fire under enforce ON', () => {
    const violations = decideExposureAdmission({
      rules: { ...ENFORCED, warnOnNewPublishedPorts: false },
      specs: [
        spec({
          name: 'postgres',
          labels: { 'swarmy.expose': 'private', 'swarmy.db.cluster': 'main' },
          ports: [{ target: 5432, published: 5432, protocol: 'tcp' }],
        }),
      ],
      live: noLive,
    });
    expect(violations.map((v) => v.rule).sort()).toEqual([
      'exposure/intent-private-published-port',
      'exposure/no-public-ports-on-managed-data',
    ]);
  });

  it('specs without published ports never violate', () => {
    const violations = decideExposureAdmission({
      rules: ENFORCED,
      specs: [
        spec({ labels: { 'swarmy.db.cluster': 'main' }, ports: [{ target: 5432 }] }),
        spec({ name: 'worker' }),
      ],
      live: noLive,
    });
    expect(violations).toEqual([]);
  });

  it('disabled individual rules are skipped even when enforcing', () => {
    const violations = decideExposureAdmission({
      rules: {
        enforce: true,
        noPublicPortsOnManagedData: false,
        noPublicUdp: false,
        warnOnNewPublishedPorts: false,
        enforceDeclaredIntent: false,
      },
      specs: [
        spec({
          labels: { 'swarmy.db.cluster': 'main' },
          ports: [{ target: 5432, published: 5432, protocol: 'udp' }],
        }),
      ],
      live: noLive,
    });
    expect(violations).toEqual([]);
  });
});

describe('decideDeclaredIntentAdmission — intent vs the INCOMING spec', () => {
  const routesLabel = JSON.stringify([{ host: 'a.io', port: 80, tls: 'auto' }]);
  const port = { target: 80, published: 8080, protocol: 'tcp' as const };

  it('undeclared specs are untouched, whatever they carry', () => {
    expect(
      decideDeclaredIntentAdmission([
        spec({ ports: [port], labels: { 'swarmy.ingress.routes': routesLabel } }),
      ]),
    ).toEqual([]);
  });

  it('junk swarmy.expose values are ignored (not a declaration)', () => {
    expect(
      decideDeclaredIntentAdmission([spec({ labels: { 'swarmy.expose': 'internet' }, ports: [port] })]),
    ).toEqual([]);
  });

  it('public: any surface conforms — never blocked at admission', () => {
    expect(
      decideDeclaredIntentAdmission([
        spec({ labels: { 'swarmy.expose': 'public', 'swarmy.ingress.routes': routesLabel }, ports: [port] }),
        spec({ name: 'bare', labels: { 'swarmy.expose': 'public' } }),
      ]),
    ).toEqual([]);
  });

  it('private + published port → block', () => {
    const out = decideDeclaredIntentAdmission([
      spec({ labels: { 'swarmy.expose': 'private' }, ports: [port] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      rule: 'exposure/intent-private-published-port',
      severity: 'block',
      resource: 'web',
    });
    expect(out[0]!.message).toContain('8080');
  });

  it('private + ingress route label → block', () => {
    const out = decideDeclaredIntentAdmission([
      spec({ labels: { 'swarmy.expose': 'private', 'swarmy.ingress.routes': routesLabel } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule).toBe('exposure/intent-private-ingress-route');
    expect(out[0]!.message).toContain('a.io');
  });

  it('private with no surface conforms', () => {
    expect(decideDeclaredIntentAdmission([spec({ labels: { 'swarmy.expose': 'private' } })])).toEqual(
      [],
    );
  });

  it('mesh + published port and mesh + route each block (both when combined)', () => {
    const out = decideDeclaredIntentAdmission([
      spec({
        labels: { 'swarmy.expose': 'mesh', 'swarmy.ingress.routes': routesLabel },
        ports: [port],
      }),
    ]);
    expect(out.map((v) => v.rule).sort()).toEqual([
      'exposure/intent-mesh-ingress-route',
      'exposure/intent-mesh-published-port',
    ]);
    expect(out.every((v) => v.severity === 'block')).toBe(true);
  });

  it('mesh with no surface conforms', () => {
    expect(decideDeclaredIntentAdmission([spec({ labels: { 'swarmy.expose': 'mesh' } })])).toEqual([]);
  });

  it('tunnel + published port → block; tunnel + route alone conforms (driver drift is audit-time)', () => {
    const blocked = decideDeclaredIntentAdmission([
      spec({ labels: { 'swarmy.expose': 'tunnel' }, ports: [port] }),
    ]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.rule).toBe('exposure/intent-tunnel-published-port');

    expect(
      decideDeclaredIntentAdmission([
        spec({ labels: { 'swarmy.expose': 'tunnel', 'swarmy.ingress.routes': routesLabel } }),
      ]),
    ).toEqual([]);
  });

  it('unpublished (target-only) ports never trip the intent checks', () => {
    expect(
      decideDeclaredIntentAdmission([
        spec({ labels: { 'swarmy.expose': 'mesh' }, ports: [{ target: 80 }] }),
      ]),
    ).toEqual([]);
  });
});
