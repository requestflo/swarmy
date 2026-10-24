import { describe, expect, it } from 'bun:test';
import { unitVector } from '@swarmy/core/views';
import { RouteCache } from './route-cache';
import { lookupRouteCache, planRouteCache, storeRouteCache, type PlanInput } from './route-cache-plan';

const scope = (keyId = 'k1', route = 'smart', orgId = 'o1') => ({ orgId, route, keyId });
const v = (...xs: number[]) => unitVector(xs)!;
const store = () => new RouteCache<string>((s) => s.length, 10_000, 3);
const HOUR = 3_600_000;

const input = (q: string, over: Partial<PlanInput> = {}): PlanInput => ({
  orgId: 'o1',
  keyId: 'k1',
  route: 'smart',
  path: '/v1/chat/completions',
  op: 'chat',
  stream: false,
  body: { model: 'smart', messages: [{ role: 'user', content: q }] },
  settings: { smart: { ttlSeconds: 3600, similarity: 0.9 } },
  canEmbed: true,
  ...over,
});

describe('RouteCache (process memory, per org + route + key)', () => {
  it('serves the same question until its TTL, and only to the same key', () => {
    const c = store();
    c.set(scope(), 'q', 'ctx', null, 'answer', HOUR, 0);
    expect(c.same(scope(), 'q', HOUR, 1000)).toBe('answer');
    expect(c.same(scope('k2'), 'q', HOUR, 1000)).toBeNull();
    expect(c.same(scope(), 'q', HOUR, HOUR + 1)).toBeNull();
    expect(c.view('o1').routes).toEqual([]);
  });

  it('a shorter TTL set later applies to stored answers', () => {
    const c = store();
    c.set(scope(), 'q', 'ctx', null, 'a', HOUR, 0);
    expect(c.same(scope(), 'q', 60_000, 120_000)).toBeNull();
  });

  it('similar: best fresh match at or above the threshold, same context only', () => {
    const c = store();
    c.set(scope(), 'q1', 'ctx', v(1, 0), 'east', HOUR, 0);
    c.set(scope(), 'q2', 'ctx', v(0.96, 0.28), 'near-east', HOUR, 0);
    c.set(scope(), 'q3', 'other', v(1, 0.01), 'other-context', HOUR, 0);
    expect(c.similar(scope(), 'ctx', v(0.99, 0.1), 0.9, HOUR, 1)).toMatchObject({ value: 'east' });
    expect(c.similar(scope(), 'ctx', v(0, 1), 0.9, HOUR, 1)).toBeNull();
  });

  it('bounded: per-scope cap evicts the least recently used; the byte budget evicts globally', () => {
    const c = store();
    for (const q of ['a', 'b', 'c']) c.set(scope(), q, 'x', null, q, HOUR, 0);
    c.same(scope(), 'a', HOUR, 1);
    c.set(scope(), 'd', 'x', null, 'd', HOUR, 2);
    expect(['a', 'b', 'c', 'd'].map((q) => c.same(scope(), q, HOUR, 3))).toEqual(['a', null, 'c', 'd']);
    // 95 bytes an entry: the 17th crosses 1,600 and the oldest key's answer goes.
    const tiny = new RouteCache<string>((s) => s.length, 1_600, 10);
    for (let i = 0; i < 17; i++) tiny.set(scope(`k${i}`), 'q', 'x', null, 'z'.repeat(93), HOUR, 0);
    expect(tiny.same(scope('k0'), 'q', HOUR, 1)).toBeNull();
    expect(tiny.same(scope('k16'), 'q', HOUR, 1)).not.toBeNull();
    // One answer over a sixteenth of the budget is never stored.
    tiny.set(scope('big'), 'q', 'x', null, 'z'.repeat(200), HOUR, 0);
    expect(tiny.same(scope('big'), 'q', HOUR, 1)).toBeNull();
  });

  it('the sweep drops expired answers; counters are per org + route', () => {
    const c = store();
    c.set(scope(), 'q', 'x', null, 'a', 60_000, 0);
    c.set(scope('k1', 'fast'), 'q', 'x', null, 'a', HOUR, 0);
    c.sweep(61_000);
    c.count(scope(), 'lookup');
    c.count(scope(), 'same', 1500);
    const view = c.view('o1');
    expect(view.routes).toEqual([
      { route: 'fast', lookups: 0, sameHits: 0, similarHits: 0, embedErrors: 0, entries: 1, savedUsd: 0 },
      { route: 'smart', lookups: 1, sameHits: 1, similarHits: 0, embedErrors: 0, entries: 0, savedUsd: 0.0015 },
    ]);
    expect(c.view('o2').routes).toEqual([]);
  });
});

describe('planRouteCache + lookupRouteCache', () => {
  it('applies only to a route that opted in, non-streaming chat/messages', () => {
    expect(planRouteCache(input('hi'))).not.toBeNull();
    expect(planRouteCache(input('hi', { route: null }))).toBeNull();
    expect(planRouteCache(input('hi', { route: 'fast' }))).toBeNull();
    expect(planRouteCache(input('hi', { stream: true }))).toBeNull();
    expect(planRouteCache(input('hi', { op: 'embeddings' }))).toBeNull();
    expect(planRouteCache(input('hi', { canEmbed: false }))!.question).toBeNull();
    expect(planRouteCache(input('hi', { path: '/v1/messages' }))!.exact).not.toBe(planRouteCache(input('hi'))!.exact);
  });

  it('same question: no embed call; similar question: one embed call, kept for storing', async () => {
    const c = new RouteCache<string>((s) => s.length);
    const vectors: Record<string, Float32Array> = { 'capital of France?': v(1, 0), 'France capital?': v(0.98, 0.2), 'weather?': v(0, 1) };
    let calls = 0;
    const deps = { embed: async (t: string) => (calls++, vectors[t] ?? null), savedMicros: () => 100 };
    const first = planRouteCache(input('capital of France?'))!;
    const miss = await lookupRouteCache(c, first, deps);
    expect(miss.hit).toBeNull();
    storeRouteCache(c, first, miss.vector, 'Paris');
    expect((await lookupRouteCache(c, planRouteCache(input('capital  of France?'))!, deps)).hit).toMatchObject({ value: 'Paris', kind: 'same' });
    expect(calls).toBe(1);
    expect((await lookupRouteCache(c, planRouteCache(input('France capital?'))!, deps)).hit).toMatchObject({ value: 'Paris', kind: 'similar' });
    expect((await lookupRouteCache(c, planRouteCache(input('weather?'))!, deps)).hit).toBeNull();
    expect((await lookupRouteCache(c, planRouteCache(input('unknown'))!, deps)).hit).toBeNull();
    expect(c.view('o1').routes[0]).toMatchObject({ lookups: 5, sameHits: 1, similarHits: 1, embedErrors: 1, savedUsd: 0.0002 });
  });
});
