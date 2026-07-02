import { describe, expect, it } from 'bun:test';
import {
  RpmWindow,
  TtlLruCache,
  budgetExhausted,
  costMicros,
  estimateTokens,
  keyLimits,
  parseGatewayConfig,
  parseUsageFromSse,
  parseUsageJson,
  redactPrompt,
  resolveProviderKind,
  startOfUtcDay,
  upstreamHeaders,
  type ProviderDescriptor,
} from './ai-gateway';

const p = (kind: ProviderDescriptor['kind'], over: Partial<ProviderDescriptor> = {}): ProviderDescriptor => ({
  kind,
  baseUrl: null,
  isDefault: false,
  ...over,
});

describe('resolveProviderKind — model → provider routing', () => {
  const all = [p('anthropic'), p('openai'), p('custom', { isDefault: true, baseUrl: 'https://x' })];

  it('routes claude* to anthropic and gpt*/o<digit>* to openai', () => {
    expect(resolveProviderKind('claude-haiku-4-5', all)).toBe('anthropic');
    expect(resolveProviderKind('claude-opus-4-8', all)).toBe('anthropic');
    expect(resolveProviderKind('gpt-4o-mini', all)).toBe('openai');
    expect(resolveProviderKind('o3', all)).toBe('openai');
    expect(resolveProviderKind('o4-mini', all)).toBe('openai');
    expect(resolveProviderKind('text-embedding-3-small', all)).toBe('openai');
  });

  it('does not treat non-o-series o-words as openai', () => {
    // "ollama-llama3" must fall through to the default provider.
    expect(resolveProviderKind('ollama-llama3', all)).toBe('custom');
  });

  it('routes unknown prefixes to the default provider', () => {
    expect(resolveProviderKind('llama-3.3-70b', all)).toBe('custom');
    const defaulted = [p('anthropic', { isDefault: true }), p('openai')];
    expect(resolveProviderKind('mistral-large', defaulted)).toBe('anthropic');
  });

  it('falls back to the default when the prefix provider is unconfigured', () => {
    const onlyCustom = [p('custom', { isDefault: true, baseUrl: 'https://x' })];
    expect(resolveProviderKind('claude-sonnet-5', onlyCustom)).toBe('custom');
    expect(resolveProviderKind('gpt-4o', onlyCustom)).toBe('custom');
  });

  it('uses the first configured provider when nothing is default', () => {
    expect(resolveProviderKind('mystery-model', [p('openai'), p('anthropic')])).toBe('openai');
  });

  it('returns null when nothing is configured', () => {
    expect(resolveProviderKind('claude-opus-4-8', [])).toBeNull();
  });
});

describe('costMicros — static $/MTok estimate table', () => {
  it('prices anthropic models per tier ($/MTok == µ$/token)', () => {
    // claude-haiku-4-5: $1 in / $5 out per MTok.
    expect(costMicros('claude-haiku-4-5', 1000, 1000)).toBe(6000);
    // claude-opus-4-8: $5 / $25.
    expect(costMicros('claude-opus-4-8', 1_000_000, 0)).toBe(5_000_000);
    // claude-fable-5 must not match the shorter 'claude' prefix rate.
    expect(costMicros('claude-fable-5', 1_000_000, 1_000_000)).toBe(60_000_000);
    expect(costMicros('claude-sonnet-5', 1000, 0)).toBe(3000);
  });

  it('longest prefix wins (gpt-4o-mini vs gpt-4o)', () => {
    expect(costMicros('gpt-4o-mini', 1_000_000, 0)).toBe(150_000);
    expect(costMicros('gpt-4o', 1_000_000, 0)).toBe(2_500_000);
    expect(costMicros('o4-mini', 1_000_000, 0)).toBe(1_100_000);
  });

  it('prices embeddings with zero output cost', () => {
    expect(costMicros('text-embedding-3-small', 1_000_000, 0)).toBe(20_000);
  });

  it('falls back to the default rate for unknown models', () => {
    expect(costMicros('llama-3.3-70b', 1_000_000, 1_000_000)).toBe(10_000_000);
  });

  it('rounds to whole micro-dollars and handles zero', () => {
    expect(costMicros('claude-haiku-4-5', 0, 0)).toBe(0);
    expect(costMicros('gpt-4o-mini', 1, 1)).toBe(1); // 0.15 + 0.6 = 0.75 → 1
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

describe('parseUsageJson', () => {
  it('reads anthropic usage', () => {
    expect(
      parseUsageJson('anthropic', { usage: { input_tokens: 12, output_tokens: 34 } }),
    ).toEqual({ inTokens: 12, outTokens: 34 });
  });

  it('reads openai usage (chat + embeddings)', () => {
    expect(
      parseUsageJson('openai', { usage: { prompt_tokens: 7, completion_tokens: 3 } }),
    ).toEqual({ inTokens: 7, outTokens: 3 });
    expect(parseUsageJson('openai', { usage: { prompt_tokens: 9, total_tokens: 9 } })).toEqual({
      inTokens: 9,
      outTokens: 0,
    });
  });

  it('returns null when usage is absent or malformed', () => {
    expect(parseUsageJson('anthropic', {})).toBeNull();
    expect(parseUsageJson('openai', { usage: { prompt_tokens: 'x' } })).toBeNull();
    expect(parseUsageJson('openai', null)).toBeNull();
  });
});

describe('parseUsageFromSse — best-effort stream tail parse', () => {
  it('combines anthropic message_start input with final message_delta output', () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":118}}',
      '',
    ].join('\n');
    expect(parseUsageFromSse('anthropic', sse)).toEqual({ inTokens: 25, outTokens: 118 });
  });

  it('reads the openai include_usage final chunk and ignores [DONE]', () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":42}}',
      'data: [DONE]',
      '',
    ].join('\n');
    expect(parseUsageFromSse('openai', sse)).toEqual({ inTokens: 11, outTokens: 42 });
  });

  it('returns null when the tail carries no usage (caller estimates)', () => {
    const sse = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n';
    expect(parseUsageFromSse('openai', sse)).toBeNull();
    expect(parseUsageFromSse('anthropic', 'data: not-json\n')).toBeNull();
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

describe('parseGatewayConfig (mirror of ai.service parseConfigDoc)', () => {
  it('parses the wrapper doc + settings without creds', () => {
    const cfg = parseGatewayConfig(
      {
        providers: [{ kind: 'anthropic', isDefault: true }, { kind: 'custom', baseUrl: 'https://llm.internal/' }],
        settings: { auditLog: true, cache: false },
      },
      null,
    );
    expect(cfg.providers).toEqual([
      { kind: 'anthropic', baseUrl: null, isDefault: true },
      { kind: 'custom', baseUrl: 'https://llm.internal', isDefault: false },
    ]);
    expect(cfg.settings).toEqual({ auditLog: true, cache: false });
    expect(cfg.keys).toEqual({});
  });

  it('tolerates the spine default and garbage', () => {
    expect(parseGatewayConfig([], null).providers).toEqual([]);
    expect(parseGatewayConfig('junk', null).providers).toEqual([]);
    expect(parseGatewayConfig({ providers: [{ kind: 'nope' }] }, null).providers).toEqual([]);
  });

  it('treats an undecryptable configEnc as no keys stored', () => {
    const cfg = parseGatewayConfig({ providers: [{ kind: 'openai' }] }, 'v1.bogus.blob.zz');
    expect(cfg.keys).toEqual({});
  });
});

describe('upstreamHeaders', () => {
  it('anthropic gets x-api-key + anthropic-version, never a bearer', () => {
    const h = upstreamHeaders('anthropic', 'sk-ant-x');
    expect(h['x-api-key']).toBe('sk-ant-x');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h.authorization).toBeUndefined();
  });

  it('openai/custom get a bearer token', () => {
    expect(upstreamHeaders('openai', 'sk-x').authorization).toBe('Bearer sk-x');
    expect(upstreamHeaders('custom', 'k').authorization).toBe('Bearer k');
  });
});

describe('budget limiter', () => {
  it('parses limitsJson with unlimited fallbacks', () => {
    expect(keyLimits({ rpm: 60, dailyBudgetMicros: 5_000_000 })).toEqual({
      rpm: 60,
      dailyBudgetMicros: 5_000_000,
    });
    expect(keyLimits({})).toEqual({ rpm: null, dailyBudgetMicros: null });
    expect(keyLimits(null)).toEqual({ rpm: null, dailyBudgetMicros: null });
    expect(keyLimits({ rpm: -1, dailyBudgetMicros: 'lots' })).toEqual({
      rpm: null,
      dailyBudgetMicros: null,
    });
  });

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
