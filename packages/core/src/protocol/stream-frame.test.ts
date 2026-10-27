import { describe, expect, it } from 'bun:test';
import { STREAM_FRAME_HEADER_BYTES, decodeStreamChunk, encodeStreamChunk } from './stream-frame';

const ID = '5f0c2a1e-9b3d-4c7a-8e21-0d4f6a8b2c3e';

describe('binary stream chunk frame', () => {
  it('round-trips id, seq and bytes', () => {
    const data = new Uint8Array([0, 1, 2, 255, 128, 10, 13]);
    const frame = encodeStreamChunk(ID, 7, data);
    expect(frame.byteLength).toBe(STREAM_FRAME_HEADER_BYTES + data.byteLength);
    const back = decodeStreamChunk(frame);
    expect(back?.streamId).toBe(ID);
    expect(back?.seq).toBe(7);
    expect([...back!.data]).toEqual([...data]);
  });

  it('lowercases an uppercase id and carries the largest u32 seq', () => {
    const back = decodeStreamChunk(encodeStreamChunk(ID.toUpperCase(), 0xffff_ffff, new Uint8Array()));
    expect(back).toEqual({ streamId: ID, seq: 0xffff_ffff, data: new Uint8Array() });
  });

  it('decodes a frame that is a view into a larger buffer (as Bun hands it over)', () => {
    const frame = encodeStreamChunk(ID, 3, new Uint8Array([9, 9]));
    const big = new Uint8Array(frame.byteLength + 5);
    big.set(frame, 5);
    const back = decodeStreamChunk(big.subarray(5));
    expect(back?.seq).toBe(3);
    expect([...back!.data]).toEqual([9, 9]);
  });

  it('refuses a non-uuid id and an out-of-range seq', () => {
    expect(() => encodeStreamChunk('not-a-uuid', 0, new Uint8Array())).toThrow();
    expect(() => encodeStreamChunk(ID, -1, new Uint8Array())).toThrow();
    expect(() => encodeStreamChunk(ID, 2 ** 32, new Uint8Array())).toThrow();
  });

  it('decodes nothing that is not a v1 chunk: short frames, other kinds, JSON text bytes', () => {
    expect(decodeStreamChunk(new Uint8Array(20))).toBeNull();
    const other = encodeStreamChunk(ID, 0, new Uint8Array([1]));
    other[0] = 0x02;
    expect(decodeStreamChunk(other)).toBeNull();
    expect(decodeStreamChunk(new TextEncoder().encode('{"v":1,"type":"streamEnd","payload":{}}'))).toBeNull();
  });
});
