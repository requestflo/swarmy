import { describe, expect, it } from 'bun:test';
import { cacheKeyParts, cosine, normaliseText, parseRouteCache, unitVector } from './ai-cache';
import { cacheHitRatePct } from './ai-cache-stats';
import { parseConfigDoc, serializeConfigDoc } from './ai-gateway';

const chat = (content: unknown, extra: Record<string, unknown> = {}) => ({
  model: 'smart',
  messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content }],
  ...extra,
});

describe('answer cache keys: same question ⇔ same key', () => {
  it('whitespace, line endings and JSON key order do not count', () => {
    const a = cacheKeyParts(chat('What is  the capital\tof France?  '))!;
    const b = cacheKeyParts({ messages: [{ content: 'Be brief.', role: 'system' }, { content: 'What is the capital of France?', role: 'user' }], model: 'smart' })!;
    expect(a.exact).toBe(b.exact);
    expect(normaliseText('a\r\nb   \n\n\n\nc')).toBe('a\nb\n\nc');
  });

  it('case, punctuation and indentation do count (they can change the answer)', () => {
    const base = cacheKeyParts(chat('Rename Foo to foo'))!.exact;
    expect(cacheKeyParts(chat('rename foo to Foo'))!.exact).not.toBe(base);
    expect(cacheKeyParts(chat('Rename Foo to foo!'))!.exact).not.toBe(base);
    expect(normaliseText('if a:\n    x()\n    y()')).not.toBe(normaliseText('if a:\n    x()\ny()'));
  });

  it('every parameter that changes the answer is in the key; stream/user/metadata are not', () => {
    const base = cacheKeyParts(chat('hi'))!.exact;
    expect(cacheKeyParts(chat('hi', { temperature: 0.2 }))!.exact).not.toBe(base);
    expect(cacheKeyParts(chat('hi', { model: 'fast' }))!.exact).not.toBe(base);
    expect(cacheKeyParts(chat('hi', { tools: [{ type: 'function', function: { name: 'f' } }] }))!.exact).not.toBe(base);
    expect(cacheKeyParts(chat('hi', { stream: false, user: 'u1', metadata: { a: 1 } }))!.exact).toBe(base);
  });

  it('context is the conversation before the question; the question is the last user text', () => {
    const a = cacheKeyParts(chat('What is the capital of France?'))!;
    const b = cacheKeyParts(chat('Which city is France’s capital?'))!;
    expect(a.context).toBe(b.context);
    expect(a.exact).not.toBe(b.exact);
    expect(a.question).toBe('What is the capital of France?');
    expect(cacheKeyParts(chat('x', { system: 'Other.' }))!.context).not.toBe(a.context);
  });

  it('no similarity for images, tool results or an empty body', () => {
    expect(cacheKeyParts(chat([{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:x' } }]))!.question).toBeNull();
    expect(cacheKeyParts({ messages: [{ role: 'tool', content: '42', tool_call_id: 't' }] })!.question).toBeNull();
    expect(cacheKeyParts(chat([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]))!.question).toBe('a\nb');
    expect(cacheKeyParts({ model: 'smart' })).toBeNull();
  });
});

describe('route cache settings', () => {
  it('clamps TTL and threshold, defaults the TTL, keeps null similarity', () => {
    expect(parseRouteCache({})).toEqual({ ttlSeconds: 3600, similarity: null });
    expect(parseRouteCache({ ttlSeconds: 5, similarity: 0.5 })).toEqual({ ttlSeconds: 60, similarity: 0.8 });
    expect(parseRouteCache({ ttlSeconds: 1e9, similarity: 1 })).toEqual({ ttlSeconds: 604800, similarity: 0.999 });
    expect(parseRouteCache('on')).toBeNull();
  });

  it('round-trips on the config document; bad route names are dropped', () => {
    const doc = parseConfigDoc({ routeCache: { smart: { ttlSeconds: 600, similarity: 0.9 }, 'bad name': {} } });
    expect(doc.routeCache).toEqual({ smart: { ttlSeconds: 600, similarity: 0.9 } });
    expect(parseConfigDoc(serializeConfigDoc(doc)).routeCache).toEqual(doc.routeCache);
    expect(parseConfigDoc([]).routeCache).toEqual({});
  });
});

describe('vectors + hit rate', () => {
  it('cosine of unit vectors; other dimensions never match', () => {
    const a = unitVector([3, 4])!;
    expect(cosine(a, unitVector([6, 8])!)).toBeCloseTo(1, 6);
    expect(cosine(a, unitVector([-4, 3])!)).toBeCloseTo(0, 6);
    expect(cosine(a, unitVector([1, 2, 3])!)).toBe(-1);
    expect(unitVector([0, 0])).toBeNull();
    expect(unitVector([])).toBeNull();
  });

  it('hit rate is hits over lookups, null before the first lookup', () => {
    expect(cacheHitRatePct({ lookups: 0, sameHits: 0, similarHits: 0 })).toBeNull();
    expect(cacheHitRatePct({ lookups: 8, sameHits: 2, similarHits: 1 })).toBe(37.5);
  });
});
