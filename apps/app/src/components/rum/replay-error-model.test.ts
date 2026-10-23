import { describe, expect, test } from 'bun:test';
import { frameLine, linkedError, requestLine } from './replay-error-model';

const frame = (o: Record<string, unknown>) => ({
  filename: 'x.js', function: null, lineno: 1, colno: 1, inApp: false, module: null,
  preContext: [], contextLine: null, postContext: [], minified: null, sourcemap: null, ...o,
});

describe('linkedError', () => {
  test('takes the first tracked error and keeps only a real event id', () => {
    const e = linkedError([
      { title: 'no fingerprint' },
      { fingerprint: 'f3a9', event_id: 'abc', exc_type: 'TypeError', exc_value: 'x is undefined', trace_id: 't1', ts_ms: 70 },
    ]);
    expect(e).toEqual({ fingerprint: 'f3a9', eventId: null, title: 'TypeError: x is undefined', traceId: 't1', tsMs: 70 });
    expect(linkedError([{ fingerprint: 'f', event_id: 'a'.repeat(32) }])?.eventId).toBe('a'.repeat(32));
    expect(linkedError([])).toBeNull();
  });
});

describe('frameLine', () => {
  test('says the source-mapped crash frame', () => {
    const frames = [
      frame({ filename: 'react-dom.js', lineno: 4120 }),
      frame({ filename: 'src/pay.ts', lineno: 88, inApp: true, minified: { filename: 'assets/index.js', function: 'a', lineno: 1, colno: 9 } }),
    ];
    expect(frameLine({ exceptions: [{ type: 'T', value: 'v', mechanism: null, handled: null, frames }] })).toBe(
      'assets/index.js:1 → src/pay.ts:88 (source map)',
    );
  });

  test('falls back to where it threw, or nothing', () => {
    const frames = [frame({ filename: 'app.js', lineno: 3 })];
    expect(frameLine({ exceptions: [{ type: 'T', value: 'v', mechanism: null, handled: null, frames }] })).toBe('app.js:3');
    expect(frameLine({ exceptions: [] })).toBeNull();
    expect(frameLine(null)).toBeNull();
  });
});

describe('requestLine', () => {
  const span = (o: Record<string, unknown>) => ({
    traceId: 't1', spanId: 's', service: 'web', name: 'n', startMs: 0, durationMs: 1, status: '', method: '', path: '', httpStatus: '', ...o,
  });
  test('reads the root span of the trace', () => {
    const reqs = [span({ service: 'checkout', durationMs: 900 }), span({ method: 'POST', path: '/api/checkout', httpStatus: '500', durationMs: 1800 })];
    expect(requestLine(reqs, 't1')).toBe('POST /api/checkout 500');
    expect(requestLine(reqs, 't2')).toBeNull();
    expect(requestLine(reqs, null)).toBeNull();
  });
});
