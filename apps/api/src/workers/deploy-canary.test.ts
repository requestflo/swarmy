import { describe, expect, it } from 'bun:test';
import {
  decideCanary,
  parseCanaryParams,
  parseRoutesLabel,
  promoteSpecFrom,
  stripCanaryFromRoutes,
} from './deploy-canary.core';

// ── decideCanary — the promote/rollback decision fn ───────────────────────────

const base = {
  elapsedMin: 5,
  durationMin: 15,
  rollbackOnErrorRatePct: 5 as number | null,
  canaryErrorRatePct: 1 as number | null,
  canaryDown: false,
};

describe('decideCanary', () => {
  it('waits inside a clean window', () => {
    expect(decideCanary(base)).toBe('wait');
  });

  it('promotes once the window elapses clean', () => {
    expect(decideCanary({ ...base, elapsedMin: 15 })).toBe('promote');
    expect(decideCanary({ ...base, elapsedMin: 300 })).toBe('promote');
  });

  it('rolls back on an error-rate breach — even after the window', () => {
    expect(decideCanary({ ...base, canaryErrorRatePct: 5.1 })).toBe('rollback');
    expect(decideCanary({ ...base, elapsedMin: 20, canaryErrorRatePct: 12 })).toBe('rollback');
  });

  it('a rate AT the ceiling does not trip (strictly greater)', () => {
    expect(decideCanary({ ...base, canaryErrorRatePct: 5 })).toBe('wait');
  });

  it('dead canary tasks roll back whatever the clock or telemetry says', () => {
    expect(decideCanary({ ...base, canaryDown: true, canaryErrorRatePct: null })).toBe('rollback');
    expect(decideCanary({ ...base, canaryDown: true, elapsedMin: 60 })).toBe('rollback');
  });

  it('blind telemetry never blocks promotion (null rate = no evidence of trouble)', () => {
    expect(decideCanary({ ...base, canaryErrorRatePct: null, elapsedMin: 15 })).toBe('promote');
    expect(decideCanary({ ...base, canaryErrorRatePct: null })).toBe('wait');
  });

  it('a null threshold disables the error-rate rollback entirely', () => {
    expect(decideCanary({ ...base, rollbackOnErrorRatePct: null, canaryErrorRatePct: 90 })).toBe('wait');
    expect(
      decideCanary({ ...base, rollbackOnErrorRatePct: null, canaryErrorRatePct: 90, elapsedMin: 15 }),
    ).toBe('promote');
  });
});

// ── label codecs (mirrors of the releases.service canonical copies) ───────────

describe('parseCanaryParams (worker mirror)', () => {
  const params = {
    trafficPct: 10,
    durationMin: 15,
    rollbackOnErrorRatePct: 5,
    stableImage: 'img:1',
    startedAt: '2026-07-02T09:00:00.000Z',
  };

  it('round-trips and tolerates garbage', () => {
    expect(parseCanaryParams(JSON.stringify(params))).toEqual(params);
    expect(parseCanaryParams(undefined)).toBeNull();
    expect(parseCanaryParams('{bad')).toBeNull();
    expect(parseCanaryParams(JSON.stringify({ ...params, durationMin: 0 }))).toBeNull();
  });
});

describe('route canary stripping', () => {
  it('drops the canary fragment and keeps everything else', () => {
    const label = JSON.stringify([
      { host: 'a.com', port: 3000, tls: 'auto', canary: { service: 'web--canary', port: 3000, weightPct: 10 } },
      { host: 'b.com', port: 8080, tls: 'off', path: '/x' },
    ]);
    const stripped = stripCanaryFromRoutes(parseRoutesLabel(label));
    expect(stripped).toEqual([
      { host: 'a.com', port: 3000, tls: 'auto' },
      { host: 'b.com', port: 8080, tls: 'off', path: '/x' },
    ]);
  });

  it('a malformed label parses to [] (never throws in the tick)', () => {
    expect(parseRoutesLabel(undefined)).toEqual([]);
    expect(parseRoutesLabel('{not-an-array}')).toEqual([]);
    expect(parseRoutesLabel('"just a string"')).toEqual([]);
  });
});

// ── promoteSpecFrom smoke (canonical deep test lives in @swarmy/trpc) ─────────

describe('promoteSpecFrom (worker mirror)', () => {
  it('swaps the image and keeps the essentials', () => {
    const spec = promoteSpecFrom(
      {
        Spec: {
          Name: 'shop_web',
          Mode: { Replicated: { Replicas: 3 } },
          TaskTemplate: { ContainerSpec: { Env: ['A=1'] } },
        },
      },
      'img:2',
      ['shop_default'],
    );
    expect(spec).toEqual({
      name: 'shop_web',
      image: 'img:2',
      mode: { replicated: { replicas: 3 } },
      env: { A: '1' },
      networks: ['shop_default'],
    });
  });

  it('returns null on unusable payloads', () => {
    expect(promoteSpecFrom(null, 'img', [])).toBeNull();
    expect(promoteSpecFrom({ Spec: {} }, 'img', [])).toBeNull();
  });
});
