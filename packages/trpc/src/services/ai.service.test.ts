import { describe, expect, it } from 'bun:test';
import {
  aggregateUsage,
  generateVirtualKey,
  parseConfigDoc,
  parseKeyLimits,
} from './ai.service';

describe('parseConfigDoc — providersJson codec', () => {
  it('parses the spine default ([]) into an empty doc with default settings', () => {
    const doc = parseConfigDoc([]);
    expect(doc.providers).toEqual([]);
    expect(doc.settings).toEqual({ auditLog: false, cache: false });
  });

  it('parses the wrapper form with providers + settings', () => {
    const doc = parseConfigDoc({
      providers: [
        { kind: 'anthropic', isDefault: true },
        { kind: 'custom', baseUrl: 'https://llm.internal', isDefault: false },
      ],
      settings: { auditLog: true, cache: true },
    });
    expect(doc.providers).toEqual([
      { kind: 'anthropic', baseUrl: null, isDefault: true },
      { kind: 'custom', baseUrl: 'https://llm.internal', isDefault: false },
    ]);
    expect(doc.settings).toEqual({ auditLog: true, cache: true });
  });

  it('accepts a bare descriptor array (legacy shape)', () => {
    const doc = parseConfigDoc([{ kind: 'openai' }]);
    expect(doc.providers).toEqual([{ kind: 'openai', baseUrl: null, isDefault: false }]);
  });

  it('drops malformed entries, unknown kinds and duplicates', () => {
    const doc = parseConfigDoc({
      providers: [
        null,
        42,
        { kind: 'gemini' },
        { kind: 'openai' },
        { kind: 'openai', baseUrl: 'https://dupe' },
        { baseUrl: 'https://no-kind' },
      ],
    });
    expect(doc.providers).toEqual([{ kind: 'openai', baseUrl: null, isDefault: false }]);
  });

  it('keeps only the first default when several claim it', () => {
    const doc = parseConfigDoc({
      providers: [
        { kind: 'anthropic', isDefault: true },
        { kind: 'openai', isDefault: true },
      ],
    });
    expect(doc.providers.filter((p) => p.isDefault).map((p) => p.kind)).toEqual(['anthropic']);
  });

  it('never throws on garbage', () => {
    expect(parseConfigDoc(null).providers).toEqual([]);
    expect(parseConfigDoc('nonsense').providers).toEqual([]);
    expect(parseConfigDoc({ settings: 'nope' }).settings).toEqual({ auditLog: false, cache: false });
  });
});

describe('parseKeyLimits', () => {
  it('parses rpm + dailyBudgetMicros (micros → USD)', () => {
    expect(parseKeyLimits({ rpm: 60, dailyBudgetMicros: 2_500_000 })).toEqual({
      rpm: 60,
      dailyBudgetUsd: 2.5,
    });
  });

  it('treats missing/invalid/non-positive values as unlimited', () => {
    expect(parseKeyLimits({})).toEqual({ rpm: null, dailyBudgetUsd: null });
    expect(parseKeyLimits(null)).toEqual({ rpm: null, dailyBudgetUsd: null });
    expect(parseKeyLimits({ rpm: -5, dailyBudgetMicros: 0 })).toEqual({ rpm: null, dailyBudgetUsd: null });
    expect(parseKeyLimits({ rpm: 'many' })).toEqual({ rpm: null, dailyBudgetUsd: null });
  });

  it('floors fractional rpm', () => {
    expect(parseKeyLimits({ rpm: 10.9 }).rpm).toBe(10);
  });
});

describe('generateVirtualKey', () => {
  it('mints swk-ai-… keys that are unique', () => {
    const a = generateVirtualKey();
    const b = generateVirtualKey();
    expect(a).toMatch(/^swk-ai-[A-Za-z0-9_-]{20,}$/);
    expect(a).not.toBe(b);
  });
});

describe('aggregateUsage', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  const row = (over: Partial<Parameters<typeof aggregateUsage>[0][number]>) => ({
    at: new Date('2026-07-02T08:00:00Z'),
    model: 'claude-haiku-4-5',
    keyName: 'web',
    inTokens: 100,
    outTokens: 50,
    costMicros: 350n,
    latencyMs: 400,
    cacheHit: false,
    ...over,
  });

  it('produces one bucket per day, oldest first, zero-filled', () => {
    const out = aggregateUsage([], 3, now);
    expect(out.days.map((d) => d.day)).toEqual(['2026-06-30', '2026-07-01', '2026-07-02']);
    expect(out.days.every((d) => d.requests === 0 && d.costUsd === 0)).toBe(true);
    expect(out.totals.requests).toBe(0);
    expect(out.costIsEstimate).toBe(true);
  });

  it('buckets rows into UTC days and sums tokens + cost', () => {
    const out = aggregateUsage(
      [
        row({}),
        row({ at: new Date('2026-07-01T23:59:00Z'), costMicros: 1_000_000n }),
        row({ at: new Date('2026-07-02T01:00:00Z') }),
      ],
      2,
      now,
    );
    const [d1, d2] = out.days;
    expect(d1!.day).toBe('2026-07-01');
    expect(d1!.requests).toBe(1);
    expect(d1!.costUsd).toBeCloseTo(1, 6);
    expect(d2!.requests).toBe(2);
    expect(d2!.inTokens).toBe(200);
    expect(out.totals.costUsd).toBeCloseTo(1.0007, 4);
  });

  it('breaks down by model and key, sorted by cost desc', () => {
    const out = aggregateUsage(
      [
        row({ model: 'gpt-4o', costMicros: 9_000n }),
        row({ model: 'claude-haiku-4-5', costMicros: 100n }),
        row({ model: 'gpt-4o', keyName: 'worker', costMicros: 5_000n }),
      ],
      1,
      now,
    );
    expect(out.byModel.map((m) => m.key)).toEqual(['gpt-4o', 'claude-haiku-4-5']);
    expect(out.byModel[0]!.requests).toBe(2);
    expect(out.byKey.map((k) => k.key)).toEqual(['web', 'worker']);
  });

  it('tracks cache hits and average latency', () => {
    const out = aggregateUsage(
      [row({ latencyMs: 100, cacheHit: true }), row({ latencyMs: 300 })],
      1,
      now,
    );
    expect(out.totals.cacheHits).toBe(1);
    expect(out.totals.avgLatencyMs).toBe(200);
  });

  it('ignores rows older than the window in day buckets but keeps totals honest', () => {
    const out = aggregateUsage([row({ at: new Date('2026-06-01T00:00:00Z') })], 2, now);
    expect(out.days.every((d) => d.requests === 0)).toBe(true);
    // The caller queries only the window, but the aggregator must not crash on strays.
    expect(out.totals.requests).toBe(1);
  });
});
