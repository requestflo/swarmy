import { describe, expect, it } from 'bun:test';
import {
  haversineKm,
  regionCoord,
  regionDistanceKm,
  steer,
  type SteerTarget,
} from './steer';

function t(target: string, region: string, healthy: boolean, weight?: number): SteerTarget {
  return { target, region, healthy, weight };
}

describe('haversineKm', () => {
  it('is zero for identical points', () => {
    expect(haversineKm({ lat: 10, lon: 20 }, { lat: 10, lon: 20 })).toBe(0);
  });

  it('is symmetric', () => {
    const a = { lat: 39, lon: -77 };
    const b = { lat: 53, lon: -6 };
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 6);
  });

  it('approximates a known distance (NYC↔London ≈ 5570km)', () => {
    const km = haversineKm({ lat: 40.7, lon: -74 }, { lat: 51.5, lon: -0.13 });
    expect(km).toBeGreaterThan(5400);
    expect(km).toBeLessThan(5700);
  });
});

describe('regionCoord / regionDistanceKm', () => {
  it('resolves known region labels', () => {
    expect(regionCoord('us-east')).toBeDefined();
    expect(regionCoord('eu-west')).toBeDefined();
  });

  it('falls back to a continent prefix for unknown labels', () => {
    expect(regionCoord('ap-foo')).toBeDefined();
    expect(regionCoord('eu-bar')).toBeDefined();
  });

  it('returns undefined for an unresolvable label', () => {
    expect(regionCoord('zz-nowhere')).toBeUndefined();
  });

  it('us-east is closer to us-west than to ap-northeast', () => {
    expect(regionDistanceKm('us-east', 'us-west')).toBeLessThan(
      regionDistanceKm('us-east', 'ap-northeast'),
    );
  });

  it('returns Infinity when a region is unknown', () => {
    expect(regionDistanceKm('us-east', 'zz-nowhere')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('steer — closest healthy selection', () => {
  it('picks the geographically closest healthy region first', () => {
    const r = steer({
      client: { region: 'us-east' },
      targets: [t('1.1.1.1', 'ap-northeast', true), t('2.2.2.2', 'us-west', true)],
      maxAnswers: 1,
    });
    expect(r.answers).toHaveLength(1);
    expect(r.answers[0]!.region).toBe('us-west');
    expect(r.degraded).toBe(false);
  });

  it('uses explicit client coordinates when given', () => {
    const r = steer({
      client: { coord: { lat: 51.5, lon: -0.13 } }, // London
      targets: [t('1.1.1.1', 'us-west', true), t('2.2.2.2', 'eu-west', true)],
      maxAnswers: 1,
    });
    expect(r.answers[0]!.region).toBe('eu-west');
  });

  it('returns up to maxAnswers for failover spread, closest first', () => {
    const r = steer({
      client: { region: 'eu-west' },
      targets: [
        t('1', 'ap-northeast', true),
        t('2', 'eu-central', true),
        t('3', 'us-east', true),
      ],
      maxAnswers: 2,
    });
    expect(r.answers).toHaveLength(2);
    expect(r.answers[0]!.region).toBe('eu-central');
  });
});

describe('steer — failover ordering', () => {
  it('never returns an unhealthy target while a healthy one exists', () => {
    const r = steer({
      client: { region: 'us-east' },
      targets: [t('close', 'us-east', false), t('far', 'ap-northeast', true)],
      maxAnswers: 2,
    });
    expect(r.answers.every((a) => a.healthy)).toBe(true);
    expect(r.answers[0]!.region).toBe('ap-northeast');
    expect(r.degraded).toBe(false);
  });

  it('spills to unhealthy targets when none are healthy and flags degraded', () => {
    const r = steer({
      client: { region: 'us-east' },
      targets: [t('a', 'us-west', false), t('b', 'eu-west', false)],
      maxAnswers: 2,
    });
    expect(r.answers).toHaveLength(2);
    expect(r.degraded).toBe(true);
    // Closest unhealthy still ranks first.
    expect(r.answers[0]!.region).toBe('us-west');
  });

  it('breaks distance ties by weight desc then deterministic labels', () => {
    const r = steer({
      client: { region: 'us-east' },
      targets: [
        t('low', 'us-east', true, 1),
        t('high', 'us-east', true, 5),
      ],
      maxAnswers: 1,
    });
    expect(r.answers[0]!.target).toBe('high');
  });

  it('flags unlocated when the client cannot be placed', () => {
    const r = steer({
      client: {},
      targets: [t('a', 'us-east', true)],
    });
    expect(r.unlocated).toBe(true);
    expect(r.answers).toHaveLength(1);
  });

  it('returns an empty answer set for no targets', () => {
    const r = steer({ client: { region: 'us-east' }, targets: [] });
    expect(r.answers).toHaveLength(0);
    expect(r.degraded).toBe(false);
  });
});
