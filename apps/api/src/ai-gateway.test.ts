import { describe, expect, it } from 'bun:test';
import {
  RpmWindow,
  TtlLruCache,
  appOfKey,
  budgetExhausted,
  estimateTokens,
  parseGatewayConfig,
  presentedKey,
  promptCap,
  redactPrompt,
  startOfUtcDay,
} from './ai-gateway';

describe('presentedKey — any header a stock SDK sends', () => {
  const h = (m: Record<string, string>) => (n: string) => m[n];
  it('accepts x-swarmy-ai-key, Bearer (OpenAI SDK), x-api-key (Anthropic SDK), api-key (Azure SDK)', () => {
    expect(presentedKey(h({ 'x-swarmy-ai-key': 'swk-ai-a' }))).toBe('swk-ai-a');
    expect(presentedKey(h({ authorization: 'Bearer swk-ai-b' }))).toBe('swk-ai-b');
    expect(presentedKey(h({ 'x-api-key': 'swk-ai-c' }))).toBe('swk-ai-c');
    expect(presentedKey(h({ 'api-key': 'swk-ai-d' }))).toBe('swk-ai-d');
    expect(presentedKey(h({}))).toBeNull();
  });
});

describe('prompt cap + app scoping', () => {
  it('takes the tighter of the org guardrail and the key cap', () => {
    const doc = (n: number | null) => ({ settings: { auditLog: false, cache: false, guardrails: { redactPii: true, maxPromptTokens: n } } });
    expect(promptCap(doc(8000), { maxPromptTokens: 2000 })).toBe(2000);
    expect(promptCap(doc(1000), { maxPromptTokens: null })).toBe(1000);
    expect(promptCap(doc(null), { maxPromptTokens: null })).toBeNull();
  });
  it('the app of a key is its appRef stack', () => {
    expect(appOfKey('shop/web')).toBe('shop');
    expect(appOfKey('shop')).toBe('shop');
    expect(appOfKey(null)).toBeNull();
  });
  it('an undecryptable configEnc means no credentials', () => {
    const cfg = parseGatewayConfig({ providers: [{ kind: 'openai' }] }, 'v1.bogus.blob.zz');
    expect(cfg.keys).toEqual({});
    expect(cfg.doc.providers.map((p) => p.kind)).toEqual(['openai']);
  });
});

describe('RpmWindow — sliding 60s limiter', () => {
  it('allows up to rpm requests then blocks within the window', () => {
    const w = new RpmWindow();
    const t0 = 1_000_000;
    expect(w.allow('k', 2, t0)).toBe(true);
    expect(w.allow('k', 2, t0 + 1)).toBe(true);
    expect(w.allow('k', 2, t0 + 2)).toBe(false);
  });

  it('slides: old hits expire after 60s', () => {
    const w = new RpmWindow();
    const t0 = 0;
    expect(w.allow('k', 1, t0)).toBe(true);
    expect(w.allow('k', 1, t0 + 59_999)).toBe(false);
    expect(w.allow('k', 1, t0 + 60_000)).toBe(true);
  });

  it('scopes windows per key', () => {
    const w = new RpmWindow();
    expect(w.allow('a', 1, 0)).toBe(true);
    expect(w.allow('b', 1, 0)).toBe(true);
    expect(w.allow('a', 1, 1)).toBe(false);
  });

  it('a blocked request does not consume budget', () => {
    const w = new RpmWindow();
    expect(w.allow('k', 1, 0)).toBe(true);
    expect(w.allow('k', 1, 1)).toBe(false);
    // The blocked attempt at t=1 must not extend the window.
    expect(w.allow('k', 1, 60_000)).toBe(true);
  });
});

describe('TtlLruCache', () => {
  it('stores, hits within TTL, misses after TTL', () => {
    const c = new TtlLruCache<string>(10, 1000);
    c.set('a', 'x', 0);
    expect(c.get('a', 500)).toBe('x');
    expect(c.get('a', 1001)).toBeNull();
  });

  it('evicts the least-recently-used entry beyond max', () => {
    const c = new TtlLruCache<number>(2, 10_000);
    c.set('a', 1, 0);
    c.set('b', 2, 1);
    expect(c.get('a', 2)).toBe(1); // refresh a → b is now LRU
    c.set('c', 3, 3);
    expect(c.get('b', 4)).toBeNull();
    expect(c.get('a', 4)).toBe(1);
    expect(c.get('c', 4)).toBe(3);
  });
});

describe('redactPrompt', () => {
  it('takes the last user message, capped at 200 chars', () => {
    const long = 'x'.repeat(500);
    expect(
      redactPrompt({ messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'a' }, { role: 'user', content: long }] }),
    ).toBe('x'.repeat(200));
  });

  it('flattens content-block arrays', () => {
    expect(
      redactPrompt({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image' }] }] }),
    ).toBe('hello');
  });

  it('handles embeddings input and returns null for nothing usable', () => {
    expect(redactPrompt({ input: 'embed me' })).toBe('embed me');
    expect(redactPrompt({ input: ['a', 'b'] })).toBe('a b');
    expect(redactPrompt({ messages: [] })).toBeNull();
    expect(redactPrompt(null)).toBeNull();
  });
});

describe('budget limiter', () => {
  it('blocks at the budget boundary, never below, never when unlimited', () => {
    expect(budgetExhausted(4_999_999, 5_000_000)).toBe(false);
    expect(budgetExhausted(5_000_000, 5_000_000)).toBe(true);
    expect(budgetExhausted(5_000_000n, 5_000_000)).toBe(true);
    expect(budgetExhausted(9e12, null)).toBe(false);
    expect(budgetExhausted(0n, 5_000_000)).toBe(false);
  });
});

describe('misc helpers', () => {
  it('estimateTokens ≈ chars/4, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('startOfUtcDay truncates to the UTC midnight (budget window)', () => {
    const d = startOfUtcDay(new Date('2026-07-02T23:59:59.999Z'));
    expect(d.toISOString()).toBe('2026-07-02T00:00:00.000Z');
  });
});
