import { describe, expect, it } from 'bun:test';
import {
  addLatency,
  apportionLatency,
  decodeLatency,
  encodeLatency,
  latencyCount,
  latencyQuantile,
  latencyView,
  mergeLatency,
} from './edge-latency';

/** Caddy's default duration buckets (prometheus.DefBuckets), seconds. */
const B = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const h = (counts: number[]) => ({ bounds: B, counts });
const zeros = () => new Array<number>(B.length + 1).fill(0);
const at = (i: number, n: number) => {
  const c = zeros();
  c[i] = n;
  return c;
};

describe('latencyQuantile — Prometheus histogram_quantile semantics', () => {
  it('interpolates inside the bucket the rank falls in; the first bucket starts at 0', () => {
    // 10 requests, all in (0.025, 0.05]: p50 = 0.025 + 0.025 * 5/10.
    expect(latencyQuantile(h(at(3, 10)), 0.5)).toBeCloseTo(0.0375, 10);
    // 4 requests in [0, 0.005]: p50 = 0.005 * 2/4.
    expect(latencyQuantile(h(at(0, 4)), 0.5)).toBeCloseTo(0.0025, 10);
  });

  it('a rank in the +Inf bucket reads as the highest finite bound; nothing observed → null', () => {
    expect(latencyQuantile(h(at(11, 3)), 0.95)).toBe(10);
    expect(latencyQuantile(h(zeros()), 0.5)).toBeNull();
    expect(latencyQuantile(undefined, 0.5)).toBeNull();
  });

  it('latencyView gives p50/p95 in ms, one decimal', () => {
    // 90 fast (≤ 5 ms), 10 slow in (0.5, 1]: p50 in the first bucket, p95 in the slow one.
    const c = zeros();
    c[0] = 90;
    c[7] = 10;
    expect(latencyView(h(c))).toEqual({ p50Ms: 2.8, p95Ms: 750 });
    expect(latencyView(undefined)).toEqual({ p50Ms: null, p95Ms: null });
  });
});

describe('mergeLatency — percentiles across edges come from merged counts', () => {
  it('same bounds add bucket by bucket (and keep the shared bounds array)', () => {
    const m = mergeLatency(h(at(1, 3)), h(at(4, 2)))!;
    expect(m.bounds).toBe(B);
    expect(m.counts).toEqual([0, 3, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('merged p50 is NOT the average of each edge`s p50', () => {
    const busyFast = h(at(0, 900)); // p50 2.5 ms
    const quietSlow = h(at(7, 100)); // p50 750 ms
    const avg = (latencyView(busyFast).p50Ms! + latencyView(quietSlow).p50Ms!) / 2;
    const merged = latencyView(mergeLatency(busyFast, quietSlow)).p50Ms!;
    expect(avg).toBe(376.25);
    expect(merged).toBe(2.8); // 500th of 1000 requests is still a fast one
  });

  it('different bounds merge onto the union, each count at its own upper bound', () => {
    const a = { bounds: [0.1, 1], counts: [1, 2, 3] };
    const b = { bounds: [0.5, 1], counts: [4, 5, 6] };
    expect(mergeLatency(a, b)).toEqual({ bounds: [0.1, 0.5, 1], counts: [1, 4, 7, 9] });
    expect(mergeLatency(undefined, a)).toEqual(a);
    expect(mergeLatency(undefined, undefined)).toBeUndefined();
  });

  it('addLatency accumulates in place on the caller`s own histogram, never on the input', () => {
    const input = h(at(2, 1));
    const acc = addLatency(undefined, input)!;
    addLatency(acc, input);
    expect(acc.counts[2]).toBe(2);
    expect(input.counts[2]).toBe(1);
    expect(addLatency(acc, undefined)).toBe(acc);
  });
});

describe('apportionLatency — a delta split over minutes adds back exactly', () => {
  it('each bucket is apportioned on its own; empty parts are undefined', () => {
    const whole = h([7, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    const parts = apportionLatency(whole, [45_000, 15_000]);
    const sum = parts.reduce((acc, p) => addLatency(acc, p), undefined as ReturnType<typeof addLatency>);
    expect(sum!.counts).toEqual(whole.counts);
    expect(latencyCount(parts[0])).toBeGreaterThan(latencyCount(parts[1]));
    expect(apportionLatency(h(at(0, 1)), [1, 0])[1]).toBeUndefined();
  });
});

describe('encodeLatency / decodeLatency — the telemetry.db column', () => {
  it('round-trips and refuses junk or a malformed shape', () => {
    const x = h(at(5, 9));
    expect(decodeLatency(encodeLatency(x))).toEqual(x);
    expect(encodeLatency({ bounds: [0.1], counts: [1, 2] })).toBe('{"b":[0.1],"c":[1,2]}');
    expect(decodeLatency(null)).toBeUndefined();
    expect(decodeLatency('nope')).toBeUndefined();
    expect(decodeLatency('{"b":[0.1],"c":[1]}')).toBeUndefined();
    expect(decodeLatency('{"b":[0.1],"c":[1,-2]}')).toBeUndefined();
  });
});
