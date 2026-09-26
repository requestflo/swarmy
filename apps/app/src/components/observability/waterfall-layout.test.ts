import { describe, expect, test } from 'bun:test';
import { formatMs, layoutWaterfall, type WaterfallSpan } from './waterfall-layout';

const T = 1_790_000_000_000;
const span = (id: string, parent: string, part: string, name: string, off: number, dur: number, err = false): WaterfallSpan => ({
  span_id: id, parent_span_id: parent, service_name: part, span_name: name, start_unix_nano: `${T + off}000000`, duration_ms: dur,
  status_code: err ? 'STATUS_CODE_ERROR' : 'STATUS_CODE_OK', status_message: err ? 'timed out after 10000 ms' : '',
});

describe('layoutWaterfall', () => {
  test('orders depth-first, offsets from the earliest start, and flags the failing leaf', () => {
    const w = layoutWaterfall([
      span('s', 'c', 'checkout', 'stripe.paymentIntents.create', 70, 10_000, true),
      span('r', '', 'web', 'POST /checkout', 0, 10_120, true),
      span('a', 'r', 'api', 'POST /api/checkout', 5, 10_100, true),
      span('q', 'a', 'api', 'SELECT carts', 10, 14),
      span('c', 'a', 'checkout', 'POST /charge', 30, 10_050, true),
    ]);
    expect(w.bars.map((b) => [b.span.span_id, b.depth])).toEqual([['r', 0], ['a', 1], ['q', 2], ['c', 2], ['s', 3]]);
    expect(w.totalMs).toBe(10_120);
    expect(w.parts).toBe(3);
    expect(w.bars[0]!.leftPct).toBe(0);
    expect(w.bars[4]!.leftPct).toBeCloseTo((70 / 10_120) * 100, 5);
    // Only the leaf that failed is crimson; its failing parents aren't.
    expect(w.bars.map((b) => b.tone)).toEqual(['idle', 'info', 'info', 'info', 'bad']);
    expect(w.culprit?.span.span_id).toBe('s');
    expect(w.culprit!.share).toBeGreaterThan(0.95);
    expect(w.ticks).toEqual([0, 2530, 5060, 7590, 10_120]);
  });

  test('a slow span that did not fail is amber; a fast trace has no culprit', () => {
    const slow = layoutWaterfall([span('r', '', 'api', 'GET /cart', 0, 1000), span('d', 'r', 'db', 'SELECT', 50, 800), span('x', 'r', 'api', 'render', 860, 100)]);
    expect(slow.bars.find((b) => b.span.span_id === 'd')!.tone).toBe('warn');
    const even = layoutWaterfall([span('r', '', 'api', 'GET /', 0, 100), span('a', 'r', 'api', 'a', 0, 30), span('b', 'r', 'api', 'b', 30, 30), span('c', 'r', 'api', 'c', 60, 30)]);
    expect(even.culprit).toBeNull();
    expect(even.bars.every((b) => b.tone !== 'warn')).toBe(true);
  });

  test('orphans hang off the top, bars stay inside the track, empty is empty', () => {
    const w = layoutWaterfall([span('a', 'gone', 'api', 'a', 0, 10), span('b', '', 'api', 'b', 5, 0)]);
    expect(w.bars.map((b) => b.depth)).toEqual([0, 0]);
    for (const b of w.bars) expect(b.leftPct + b.widthPct).toBeLessThanOrEqual(100);
    expect(w.bars[1]!.widthPct).toBeGreaterThan(0);
    expect(layoutWaterfall([])).toEqual({ bars: [], totalMs: 0, ticks: [0], parts: 0, culprit: null });
  });

  test('formatMs', () => {
    expect([12.4, 999, 1342, 10_000, 64_000].map(formatMs)).toEqual(['12 ms', '999 ms', '1.3 s', '10 s', '64 s']);
  });
});
