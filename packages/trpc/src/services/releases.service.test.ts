import { describe, expect, it } from 'bun:test';
import { decideGate, diffLines, parseHealthGate, parseStrategy } from './releases.service';

describe('diffLines — simple LCS line diff', () => {
  it('marks identical sources as all-same', () => {
    const src = 'services:\n  web:\n    image: nginx:1.27';
    const d = diffLines(src, src);
    expect(d.every((l) => l.kind === 'same')).toBe(true);
    expect(d).toHaveLength(3);
    expect(d[0]).toEqual({ kind: 'same', aLine: 1, bLine: 1, text: 'services:' });
  });

  it('detects a changed line as del + add', () => {
    const a = 'services:\n  web:\n    image: nginx:1.26';
    const b = 'services:\n  web:\n    image: nginx:1.27';
    const d = diffLines(a, b);
    expect(d.map((l) => l.kind)).toEqual(['same', 'same', 'del', 'add']);
    expect(d[2]).toEqual({ kind: 'del', aLine: 3, bLine: null, text: '    image: nginx:1.26' });
    expect(d[3]).toEqual({ kind: 'add', aLine: null, bLine: 3, text: '    image: nginx:1.27' });
  });

  it('detects pure additions with correct new-line numbers', () => {
    const a = 'a\nb';
    const b = 'a\nb\nc\nd';
    const d = diffLines(a, b);
    expect(d.map((l) => l.kind)).toEqual(['same', 'same', 'add', 'add']);
    expect(d[2]?.bLine).toBe(3);
    expect(d[3]?.bLine).toBe(4);
  });

  it('detects pure deletions with correct old-line numbers', () => {
    const d = diffLines('a\nb\nc', 'a');
    expect(d.map((l) => l.kind)).toEqual(['same', 'del', 'del']);
    expect(d[1]?.aLine).toBe(2);
    expect(d[2]?.aLine).toBe(3);
  });

  it('an empty previous source yields all-add (first release)', () => {
    const d = diffLines('', 'a\nb');
    expect(d.map((l) => l.kind)).toEqual(['add', 'add']);
  });

  it('keeps surrounding context stable around a mid-file edit', () => {
    const a = 'one\ntwo\nthree\nfour';
    const b = 'one\nTWO\nthree\nfour';
    const d = diffLines(a, b);
    expect(d.filter((l) => l.kind === 'same')).toHaveLength(3);
    expect(d.find((l) => l.kind === 'del')?.text).toBe('two');
    expect(d.find((l) => l.kind === 'add')?.text).toBe('TWO');
  });
});

describe('decideGate — health-gate decision', () => {
  it('waits while inside the watch window regardless of health', () => {
    expect(decideGate({ health: 'down', elapsedSec: 10, windowSec: 120 })).toBe('wait');
    expect(decideGate({ health: 'healthy', elapsedSec: 119, windowSec: 120 })).toBe('wait');
  });

  it('passes a healthy stack once the window elapses', () => {
    expect(decideGate({ health: 'healthy', elapsedSec: 120, windowSec: 120 })).toBe('healthy');
    expect(decideGate({ health: 'healthy', elapsedSec: 500, windowSec: 120 })).toBe('healthy');
  });

  it('fails degraded and down stacks after the window', () => {
    expect(decideGate({ health: 'degraded', elapsedSec: 121, windowSec: 120 })).toBe('failed');
    expect(decideGate({ health: 'down', elapsedSec: 121, windowSec: 120 })).toBe('failed');
  });

  it('keeps waiting on unknown health inside the grace period', () => {
    expect(decideGate({ health: 'unknown', elapsedSec: 150, windowSec: 120 })).toBe('wait');
  });

  it('passes on unknown health after twice the window (never wedges)', () => {
    expect(decideGate({ health: 'unknown', elapsedSec: 240, windowSec: 120 })).toBe('healthy');
  });
});

describe('parseHealthGate — swarmy.deploy.safety label codec', () => {
  it('parses a valid gate', () => {
    expect(parseHealthGate('{"windowSec":300,"autoRollback":true}')).toEqual({
      windowSec: 300,
      autoRollback: true,
    });
  });

  it('defaults autoRollback to false when absent or non-boolean', () => {
    expect(parseHealthGate('{"windowSec":60}')).toEqual({ windowSec: 60, autoRollback: false });
    expect(parseHealthGate('{"windowSec":60,"autoRollback":"yes"}')).toEqual({
      windowSec: 60,
      autoRollback: false,
    });
  });

  it('rejects garbage, missing, and non-positive windows', () => {
    expect(parseHealthGate(undefined)).toBeNull();
    expect(parseHealthGate('')).toBeNull();
    expect(parseHealthGate('not json')).toBeNull();
    expect(parseHealthGate('{"autoRollback":true}')).toBeNull();
    expect(parseHealthGate('{"windowSec":0}')).toBeNull();
    expect(parseHealthGate('{"windowSec":-5}')).toBeNull();
  });
});

describe('parseStrategy — swarmy.deploy.strategy label codec', () => {
  it('parses a canary strategy with numeric knobs', () => {
    expect(
      parseStrategy('{"type":"canary","trafficPct":10,"durationMin":15,"rollbackOnErrorRatePct":5}'),
    ).toEqual({ type: 'canary', trafficPct: 10, durationMin: 15, rollbackOnErrorRatePct: 5 });
  });

  it('parses a bare rolling strategy', () => {
    expect(parseStrategy('{"type":"rolling"}')).toEqual({
      type: 'rolling',
      trafficPct: undefined,
      durationMin: undefined,
      rollbackOnErrorRatePct: undefined,
    });
  });

  it('rejects unknown types and garbage', () => {
    expect(parseStrategy('{"type":"yolo"}')).toBeNull();
    expect(parseStrategy('nope')).toBeNull();
    expect(parseStrategy(null)).toBeNull();
  });
});
