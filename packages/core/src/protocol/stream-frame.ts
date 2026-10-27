/**
 * The binary WS frame a stream chunk travels in (agent → controller).
 *
 *   byte 0       frame kind: 0x01 = stream chunk, v1
 *   bytes 1-16   streamId (the uuid's 16 bytes)
 *   bytes 17-20  seq, u32 big-endian (0, 1, 2, … per stream)
 *   bytes 21-    the chunk's bytes
 *
 * Measured on a Bun WS loopback with 256 KiB chunks: base64-in-JSON put 33%
 * more bytes on the wire and moved ~1 GiB/s; this frame adds 21 bytes and
 * moved ~2.6 GiB/s. Every other frame stays JSON text, so a binary frame is
 * always a chunk. Pure.
 */

export const STREAM_FRAME_CHUNK = 0x01;
export const STREAM_FRAME_HEADER_BYTES = 21;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StreamChunk {
  /** Lowercase uuid. */
  streamId: string;
  seq: number;
  data: Uint8Array;
}

/** Encode one chunk. Throws on a streamId that isn't a uuid or a seq outside u32. */
export function encodeStreamChunk(streamId: string, seq: number, data: Uint8Array): Uint8Array {
  if (!UUID_RE.test(streamId)) throw new Error('stream chunk: streamId must be a uuid');
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffff_ffff) throw new Error('stream chunk: seq out of range');
  const out = new Uint8Array(STREAM_FRAME_HEADER_BYTES + data.byteLength);
  out[0] = STREAM_FRAME_CHUNK;
  const hex = streamId.replace(/-/g, '');
  for (let i = 0; i < 16; i++) out[1 + i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(17, seq);
  out.set(data, STREAM_FRAME_HEADER_BYTES);
  return out;
}

/** Decode a binary frame, or null when it isn't a v1 stream chunk. `data` is a view, not a copy. */
export function decodeStreamChunk(frame: Uint8Array): StreamChunk | null {
  if (frame.byteLength < STREAM_FRAME_HEADER_BYTES || frame[0] !== STREAM_FRAME_CHUNK) return null;
  let hex = '';
  for (let i = 1; i <= 16; i++) hex += frame[i]!.toString(16).padStart(2, '0');
  const streamId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const seq = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(17);
  return { streamId, seq, data: frame.subarray(STREAM_FRAME_HEADER_BYTES) };
}
