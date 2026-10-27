import { describe, expect, it } from 'bun:test';
import { createFrameDemuxer, type FrameStream } from './frame-demux';

function frame(type: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h[0] = type;
  h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
}

function collect(): { out: Array<[FrameStream, number[]]>; feed: (b: Buffer) => void } {
  const out: Array<[FrameStream, number[]]> = [];
  return { out, feed: createFrameDemuxer((s, d) => out.push([s, [...d]])) };
}

describe('createFrameDemuxer (binary-safe)', () => {
  it('keeps every byte of a stdout frame, including invalid UTF-8', () => {
    const { out, feed } = collect();
    feed(frame(1, Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a])));
    expect(out).toEqual([['stdout', [0xff, 0xfe, 0x00, 0x80, 0x0a]]]);
  });

  it('reassembles frames split across chunks and splits stdout from stderr', () => {
    const { out, feed } = collect();
    const all = Buffer.concat([frame(1, Buffer.from([1, 2, 3])), frame(2, Buffer.from('oops')), frame(1, Buffer.from([4]))]);
    for (let i = 0; i < all.length; i++) feed(all.subarray(i, i + 1));
    expect(out).toEqual([
      ['stdout', [1, 2, 3]],
      ['stderr', [...Buffer.from('oops')]],
      ['stdout', [4]],
    ]);
  });

  it('refuses a stream that is not framed (it would corrupt a binary download)', () => {
    const { feed } = collect();
    expect(() => feed(Buffer.from('not a docker frame'))).toThrow();
  });
});
