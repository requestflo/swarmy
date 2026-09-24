import { describe, expect, it } from 'bun:test';
import { backoffMs, classifyFailure, parseRetryAfter, runChain, TargetHealth, type AttemptResult, type RetryOptions } from './router';
import { formatTraceparent, genAiAttributes, parseTraceparent, toOtlp, otlpTracesUrl } from './trace';

const noSleep: RetryOptions = { retries: 2, baseDelayMs: 100, maxDelayMs: 1000, sleep: async () => {}, rand: () => 0 };

/** A scripted upstream: per target, a queue of statuses (200 = ok, null = network error). */
function scripted(script: Record<string, Array<number | null>>) {
  const calls: string[] = [];
  const attempt = async (t: string): Promise<AttemptResult<string>> => {
    calls.push(t);
    const s = script[t]?.shift();
    if (s === 200) return { ok: true, value: t };
    return { ok: false, status: s ?? null, error: `boom ${s}` };
  };
  return { calls, attempt };
}

describe('classifyFailure', () => {
  it('retries busy/unavailable, skips misconfigured, stops on client errors', () => {
    expect([429, 500, 503, 408, null].map(classifyFailure)).toEqual(['retry', 'retry', 'retry', 'retry', 'retry']);
    expect([401, 403, 404].map(classifyFailure)).toEqual(['next', 'next', 'next']);
    expect([400, 413, 422].map(classifyFailure)).toEqual(['stop', 'stop', 'stop']);
  });
});

describe('runChain — retries, fallbacks, stop', () => {
  it('first target ok: one call', async () => {
    const s = scripted({ a: [200] });
    const r = await runChain(['a', 'b'], (x) => x, s.attempt, noSleep);
    expect(r.result.ok && r.result.value).toBe('a');
    expect(s.calls).toEqual(['a']);
  });

  it('retries a 429 with backoff then succeeds on the same target', async () => {
    const waits: number[] = [];
    const s = scripted({ a: [429, 503, 200] });
    const r = await runChain(['a', 'b'], (x) => x, s.attempt, { ...noSleep, sleep: async (ms) => void waits.push(ms) });
    expect(r.target).toBe('a');
    expect(s.calls).toEqual(['a', 'a', 'a']);
    expect(waits).toEqual([100, 200]);
  });

  it('falls back to the next target after exhausting retries', async () => {
    const s = scripted({ a: [500, 500, 500], b: [200] });
    const r = await runChain(['a', 'b'], (x) => x, s.attempt, noSleep);
    expect(r.target).toBe('b');
    expect(s.calls).toEqual(['a', 'a', 'a', 'b']);
    expect(r.attempts.map((a) => a.status)).toEqual([500, 500, 500, 200]);
  });

  it('a 401 skips straight to the next target (no retry)', async () => {
    const s = scripted({ a: [401], b: [200] });
    await runChain(['a', 'b'], (x) => x, s.attempt, noSleep);
    expect(s.calls).toEqual(['a', 'b']);
  });

  it('a 400 stops the chain: another provider would reject the same request', async () => {
    const s = scripted({ a: [400], b: [200] });
    const r = await runChain(['a', 'b'], (x) => x, s.attempt, noSleep);
    expect(r.result.ok).toBe(false);
    expect(s.calls).toEqual(['a']);
  });

  it('network errors (thrown or null status) are retried then fall back', async () => {
    const calls: string[] = [];
    const r = await runChain(
      ['a', 'b'],
      (x) => x,
      async (t) => {
        calls.push(t);
        if (t === 'a') throw new Error('ECONNREFUSED');
        return { ok: true, value: t };
      },
      { ...noSleep, retries: 1 },
    );
    expect(r.target).toBe('b');
    expect(calls).toEqual(['a', 'a', 'b']);
  });

  it('all fail: the last failure is returned with every attempt logged', async () => {
    const s = scripted({ a: [503, 503, 503], b: [502, 502, 502] });
    const r = await runChain(['a', 'b'], (x) => x, s.attempt, noSleep);
    expect(r.result.ok).toBe(false);
    expect(!r.result.ok && r.result.status).toBe(502);
    expect(r.attempts).toHaveLength(6);
  });

  it('retry-after wins over the exponential backoff (capped)', () => {
    expect(backoffMs(0, noSleep, 250)).toBe(250);
    expect(backoffMs(0, noSleep, 60_000)).toBe(1000);
    expect(backoffMs(3, noSleep)).toBe(800);
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('garbage')).toBeNull();
  });
});

describe('TargetHealth — cooled targets move to the back', () => {
  it('trips after N consecutive failures and recovers on success', async () => {
    const h = new TargetHealth(2, 30_000);
    h.failure('a', 0);
    expect(h.order(['a', 'b'], (x) => x, 1)).toEqual(['a', 'b']);
    h.failure('a', 0);
    expect(h.order(['a', 'b'], (x) => x, 1)).toEqual(['b', 'a']);
    expect(h.order(['a', 'b'], (x) => x, 40_000)).toEqual(['a', 'b']);
    h.success('a');
    expect(h.cooled('a', 1)).toBe(false);
  });

  it('runChain skips a cooled target first but still tries it', async () => {
    const h = new TargetHealth(1, 30_000);
    h.failure('a');
    const s = scripted({ a: [200], b: [500, 500, 500] });
    const r = await runChain(['a', 'b'], (x) => x, s.attempt, noSleep, h);
    expect(s.calls).toEqual(['b', 'b', 'b', 'a']);
    expect(r.target).toBe('a');
  });
});

describe('traces — W3C context + GenAI semconv + OTLP', () => {
  it('continues the caller trace; starts one when absent/invalid', () => {
    const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    expect(parseTraceparent(tp)).toEqual({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', parentSpanId: '00f067aa0ba902b7', sampled: true });
    const fresh = parseTraceparent('nope');
    expect(fresh.parentSpanId).toBeNull();
    expect(fresh.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01').parentSpanId).toBeNull();
    expect(formatTraceparent('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7')).toBe(tp);
  });

  it('GenAI attributes use the semconv names', () => {
    const a = genAiAttributes({ operation: 'chat', provider: 'anthropic', requestModel: 'claude-haiku-4-5', responseModel: 'claude-haiku-4-5', inTokens: 10, outTokens: 5, finishReasons: ['stop'], maxTokens: 64 });
    expect(a['gen_ai.operation.name']).toBe('chat');
    expect(a['gen_ai.provider.name']).toBe('anthropic');
    expect(a['gen_ai.request.model']).toBe('claude-haiku-4-5');
    expect(a['gen_ai.usage.input_tokens']).toBe(10);
    expect(a['gen_ai.usage.output_tokens']).toBe(5);
    expect(a['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(a['gen_ai.request.max_tokens']).toBe(64);
  });

  it('OTLP JSON: one resource per org/stack, parent link, CLIENT kind, int attrs as strings', () => {
    const otlp = toOtlp([
      {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        parentSpanId: 'c'.repeat(16),
        name: 'chat gpt-5-mini',
        kind: 'client',
        startMs: 1000,
        endMs: 1500,
        attributes: { 'gen_ai.usage.input_tokens': 3, 'gen_ai.request.temperature': 0.5, skipped: undefined },
        error: null,
        resource: { orgId: 'org1', stack: 'shop' },
      },
    ]) as { resourceSpans: Array<{ resource: { attributes: unknown[] }; scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }> };
    const rs = otlp.resourceSpans[0]!;
    expect(rs.resource.attributes).toContainEqual({ key: 'swarmy.org_id', value: { stringValue: 'org1' } });
    expect(rs.resource.attributes).toContainEqual({ key: 'swarmy.stack', value: { stringValue: 'shop' } });
    const span = rs.scopeSpans[0]!.spans[0]!;
    expect(span.kind).toBe(3);
    expect(span.parentSpanId).toBe('c'.repeat(16));
    expect(span.startTimeUnixNano).toBe('1000000000');
    expect(span.attributes).toEqual([
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '3' } },
      { key: 'gen_ai.request.temperature', value: { doubleValue: 0.5 } },
    ]);
  });

  it('export endpoint from env; off switch', () => {
    expect(otlpTracesUrl({})).toBeNull();
    expect(otlpTracesUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://swarmy-otel-collector:4318/' })).toBe('http://swarmy-otel-collector:4318/v1/traces');
    expect(otlpTracesUrl({ SWARMY_AI_OTLP_ENDPOINT: 'http://c:4318/v1/traces', SWARMY_AI_TRACES: 'off' })).toBeNull();
  });
});
