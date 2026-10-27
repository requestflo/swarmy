import { describe, expect, it } from 'bun:test';
import { CreditReceiver, CreditSender } from './stream-flow';

describe('CreditSender (agent side)', () => {
  it('sends while it holds credit, then waits', () => {
    const s = new CreditSender(2, 1000);
    expect(s.check(10)).toBe('send');
    expect(s.sent(10)).toBe(0);
    expect(s.sent(10)).toBe(1);
    expect(s.check(10)).toBe('wait');
    expect(() => s.sent(10)).toThrow();
    s.grant(1);
    expect(s.check(10)).toBe('send');
    expect(s.sent(10)).toBe(2);
    expect({ bytes: s.bytes, chunks: s.chunks }).toEqual({ bytes: 30, chunks: 3 });
  });

  it('refuses to cross the byte cap even with credit', () => {
    const s = new CreditSender(8, 25);
    s.sent(20);
    expect(s.check(5)).toBe('send');
    expect(s.check(6)).toBe('over-cap');
  });

  it('never holds more than 64 credits, and ignores junk grants', () => {
    const s = new CreditSender(100, 1);
    expect(s.available).toBe(64);
    s.grant(Number.NaN);
    s.grant(-5);
    expect(s.available).toBe(64);
    s.sent(1);
    s.grant(Number.NaN);
    expect(s.available).toBe(63);
  });
});

describe('CreditReceiver (controller side)', () => {
  it('starts the sender with the whole window and re-grants in half-window batches', () => {
    const r = new CreditReceiver(8, 1_000_000);
    expect(r.initialCredit).toBe(8);
    for (let seq = 0; seq < 8; seq++) expect(r.arrive(seq, 100)).toEqual({ ok: true });
    // The reader drains: no grant until half the window is free again.
    expect([r.consume(), r.consume(), r.consume()]).toEqual([0, 0, 0]);
    expect(r.consume()).toBe(4);
    expect([r.consume(), r.consume(), r.consume()]).toEqual([0, 0, 0]);
    expect(r.consume()).toBe(4);
  });

  it('a slow reader holds the sender at most one window ahead (backpressure)', () => {
    const r = new CreditReceiver(8, 1_000_000);
    const s = new CreditSender(r.initialCredit, 1_000_000);
    let sent = 0;
    while (s.check(1) === 'send') r.arrive(s.sent(1), 1), sent++;
    expect(sent).toBe(8); // nothing consumed yet → the sender stops at the window
    s.grant(r.consume()); // one consumed: still nothing granted
    expect(s.check(1)).toBe('wait');
    for (let i = 0; i < 3; i++) s.grant(r.consume());
    expect(s.available).toBe(4);
  });

  it('a reader that keeps up never stalls the sender (no deadlock at the tail)', () => {
    const r = new CreditReceiver(8, 1_000_000);
    const s = new CreditSender(r.initialCredit, 1_000_000);
    for (let i = 0; i < 1000; i++) {
      expect(s.check(1)).toBe('send');
      expect(r.arrive(s.sent(1), 1).ok).toBe(true);
      s.grant(r.consume());
    }
    expect(r.matches({ bytes: 1000, chunks: 1000 })).toBe(true);
  });

  it('ends the stream on a gap, a replay, a chunk past credit, or the byte cap', () => {
    const gap = new CreditReceiver(8, 100);
    expect(gap.arrive(1, 1)).toMatchObject({ ok: false, code: 'E_PROTOCOL' });
    const replay = new CreditReceiver(8, 100);
    replay.arrive(0, 1);
    expect(replay.arrive(0, 1)).toMatchObject({ ok: false, code: 'E_PROTOCOL' });
    const flood = new CreditReceiver(2, 100);
    flood.arrive(0, 1);
    flood.arrive(1, 1);
    expect(flood.arrive(2, 1)).toMatchObject({ ok: false, code: 'E_PROTOCOL' });
    const cap = new CreditReceiver(8, 10);
    cap.arrive(0, 8);
    expect(cap.arrive(1, 3)).toMatchObject({ ok: false, code: 'E_TOO_LARGE' });
  });

  it('checks the end frame against what actually arrived', () => {
    const r = new CreditReceiver(8, 100);
    r.arrive(0, 5);
    r.arrive(1, 6);
    expect(r.matches({ bytes: 11, chunks: 2 })).toBe(true);
    expect(r.matches({ bytes: 11, chunks: 3 })).toBe(false);
    expect(r.matches({ bytes: 12, chunks: 2 })).toBe(false);
  });
});
