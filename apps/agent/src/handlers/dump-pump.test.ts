import { describe, expect, it } from 'bun:test';
import { CreditSender } from '@swarmy/core/protocol';
import { DumpPump, stderrWhy, type PumpEnd } from './dump-pump';

function harness(credit: number, chunkBytes: number, maxBytes = 1_000_000) {
  const log: string[] = [];
  const sent: number[][] = [];
  const ends: PumpEnd[] = [];
  let clock = 0;
  const pump = new DumpPump(
    {
      sendChunk: (seq, d) => (sent.push([...d]), log.push(`send ${seq}`)),
      pause: () => log.push('pause'),
      resume: () => log.push('resume'),
      end: (r) => (ends.push(r), log.push('end')),
    },
    new CreditSender(credit, maxBytes),
    chunkBytes,
    'past this download’s limit',
    () => clock,
  );
  return { pump, log, sent, ends, tick: (ms: number) => (clock += ms) };
}

const bytes = (n: number, from = 0): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (from + i) % 256);

describe('DumpPump', () => {
  it('cuts the producer output into fixed chunks and keeps every byte in order', () => {
    const h = harness(8, 4);
    h.pump.data(bytes(6));
    h.pump.data(bytes(5, 6));
    h.pump.exited(0, '');
    expect(h.sent).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10]]);
    expect(h.ends).toEqual([{ ok: true, bytes: 11, chunks: 3 }]);
  });

  it('pauses the producer when a chunk waits for credit and resumes when credit comes', () => {
    const h = harness(1, 2);
    h.pump.data(bytes(6));
    expect(h.log).toEqual(['send 0', 'pause']);
    h.pump.credit(1);
    expect(h.log.slice(2)).toEqual(['send 1']); // still one queued: stays paused
    h.pump.credit(4);
    expect(h.log.slice(3)).toEqual(['send 2', 'resume']);
  });

  it('waits for credit before the final chunk, then ends ok exactly once', () => {
    const h = harness(1, 4);
    h.pump.data(bytes(6));
    h.pump.exited(0, '');
    expect(h.ends).toEqual([]);
    h.pump.credit(1);
    expect(h.ends).toEqual([{ ok: true, bytes: 6, chunks: 2 }]);
    h.pump.credit(1);
    h.pump.exited(0, '');
    expect(h.ends.length).toBe(1);
  });

  it('stops at the byte cap as soon as the producer passes it', () => {
    const h = harness(8, 4, 10);
    h.pump.data(bytes(8));
    h.pump.data(bytes(3));
    expect(h.ends).toEqual([{ ok: false, bytes: 8, error: { code: 'E_TOO_LARGE', message: 'past this download’s limit' } }]);
    h.pump.data(bytes(3));
    expect(h.sent.length).toBe(2);
  });

  it('turns a failed restic into the reason, and a missing path into E_NOT_FOUND', () => {
    const a = harness(8, 4);
    a.pump.data(bytes(2));
    a.pump.exited(1, 'reading index\nFatal: cannot dump file: path "/data/nope" not found in snapshot\n');
    expect(a.ends[0]).toMatchObject({ ok: false, error: { code: 'E_NOT_FOUND' } });
    expect(a.sent).toEqual([]);
    const b = harness(8, 4);
    b.pump.exited(1, 'Fatal: wrong password or no key found\n');
    expect(b.ends[0]).toMatchObject({ ok: false, error: { code: 'E_SOURCE', message: 'Fatal: wrong password or no key found' } });
  });

  it('reports how long it has waited for credit, and only while waiting', () => {
    const h = harness(1, 2);
    h.pump.data(bytes(2));
    h.tick(50_000);
    expect(h.pump.stalledFor()).toBe(0); // nothing queued
    h.pump.data(bytes(2));
    h.tick(61_000);
    expect(h.pump.stalledFor()).toBe(61_000);
    h.pump.credit(1);
    expect(h.pump.stalledFor()).toBe(0);
  });

  it('a cancel ends it as failed and later output is dropped', () => {
    const h = harness(8, 4);
    h.pump.fail('E_CANCELED', 'the browser went away');
    h.pump.data(bytes(4));
    expect(h.sent).toEqual([]);
    expect(h.ends).toEqual([{ ok: false, bytes: 0, error: { code: 'E_CANCELED', message: 'the browser went away' } }]);
    expect(h.pump.done).toBe(true);
  });

  it('stderrWhy keeps the last lines', () => {
    expect(stderrWhy('a\nb\nc\nd\ne\n')).toBe('b\nc\nd\ne');
    expect(stderrWhy('')).toBe('restic stopped without saying why');
  });
});
