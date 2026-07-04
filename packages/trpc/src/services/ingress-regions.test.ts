import { describe, expect, it } from 'bun:test';
import { regionUpstreamsFor, siblingSetSignature, type LiveServiceLite } from './ingress-regions';

const services: LiveServiceLite[] = [
  { name: 'web', labels: {} },
  {
    name: 'web-za-johannesburg',
    labels: { 'swarmy.region.parent': 'web', 'swarmy.region.of': 'za-johannesburg' },
  },
  {
    name: 'web-uk-scotland',
    labels: { 'swarmy.region.parent': 'web', 'swarmy.region.of': 'uk-scotland' },
  },
  { name: 'api', labels: {} },
  // Sibling with a missing region label — malformed, must be skipped.
  { name: 'web-broken', labels: { 'swarmy.region.parent': 'web' } },
  // Another parent's sibling — must not leak into web's set.
  {
    name: 'api-eu-west',
    labels: { 'swarmy.region.parent': 'api', 'swarmy.region.of': 'eu-west' },
  },
];

describe('regionUpstreamsFor', () => {
  it('collects only the named parent’s siblings, region-sorted', () => {
    expect(regionUpstreamsFor('web', 3000, services)).toEqual([
      { service: 'web-uk-scotland', port: 3000, region: 'uk-scotland' },
      { service: 'web-za-johannesburg', port: 3000, region: 'za-johannesburg' },
    ]);
  });

  it('returns undefined when no siblings exist (plain VIP render)', () => {
    expect(regionUpstreamsFor('standalone', 8080, services)).toBeUndefined();
    expect(regionUpstreamsFor('standalone', 8080, [])).toBeUndefined();
  });

  it('is deterministic regardless of live-inventory order', () => {
    const reversed = [...services].reverse();
    expect(regionUpstreamsFor('web', 3000, reversed)).toEqual(
      regionUpstreamsFor('web', 3000, services),
    );
  });
});

describe('siblingSetSignature', () => {
  it('is order-insensitive and changes when a sibling appears', () => {
    expect(siblingSetSignature(services)).toBe(siblingSetSignature([...services].reverse()));
    const grown = [
      ...services,
      {
        name: 'web-eu-west',
        labels: { 'swarmy.region.parent': 'web', 'swarmy.region.of': 'eu-west' },
      },
    ];
    expect(siblingSetSignature(grown)).not.toBe(siblingSetSignature(services));
  });
});
