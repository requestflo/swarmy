import { describe, expect, it } from 'bun:test';
import {
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
  it('enforce OFF → advisory only, no violations at all', () => {
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
