/**
 * Stream framings the gateway reads and writes:
 *   - Server-Sent Events (OpenAI, Anthropic, Gemini `alt=sse`, all
 *     OpenAI-compatible engines);
 *   - the AWS event-stream binary framing (Bedrock `converse-stream`).
 * Both decoders are incremental: feed bytes as they arrive, get whole events.
 */

export interface SseEvent {
  event: string | null;
  data: string;
}

/** Incremental SSE parser (spec: blank line ends an event; `data:` lines join with \n). */
export class SseDecoder {
  private buf = '';
  private readonly td = new TextDecoder();

  push(bytes: Uint8Array | string): SseEvent[] {
    this.buf += typeof bytes === 'string' ? bytes : this.td.decode(bytes, { stream: true });
    return this.drain(false);
  }

  end(): SseEvent[] {
    this.buf += this.td.decode();
    return this.drain(true);
  }

  private drain(final: boolean): SseEvent[] {
    const out: SseEvent[] = [];
    // Normalise CRLF so one splitter handles every server.
    this.buf = this.buf.replace(/\r\n?/g, '\n');
    let idx: number;
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const ev = parseBlock(block);
      if (ev) out.push(ev);
    }
    if (final && this.buf.trim()) {
      const ev = parseBlock(this.buf);
      this.buf = '';
      if (ev) out.push(ev);
    }
    return out;
  }
}

function parseBlock(block: string): SseEvent | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length && !event) return null;
  return { event, data: data.join('\n') };
}

const te = new TextEncoder();

/** Encode one SSE event (`data:` only when no event name — the OpenAI style). */
export function encodeSse(data: string, event?: string | null): Uint8Array {
  return te.encode(`${event ? `event: ${event}\n` : ''}data: ${data}\n\n`);
}

// ── AWS event-stream (application/vnd.amazon.eventstream) ────────────────────

export interface AwsEvent {
  headers: Record<string, string>;
  payload: Uint8Array;
}

/**
 * Incremental decoder for the AWS event-stream framing:
 *   [total len u32][headers len u32][prelude crc u32][headers][payload][msg crc u32]
 * Header: [name len u8][name][type u8][value]; type 7 = string (u16 len).
 * CRCs are not verified (TLS already guarantees integrity end to end).
 */
export class AwsEventStreamDecoder {
  private buf = new Uint8Array(0);

  push(bytes: Uint8Array): AwsEvent[] {
    const next = new Uint8Array(this.buf.length + bytes.length);
    next.set(this.buf);
    next.set(bytes, this.buf.length);
    this.buf = next;
    const out: AwsEvent[] = [];
    while (this.buf.length >= 12) {
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const total = dv.getUint32(0);
      const headersLen = dv.getUint32(4);
      if (total < 16 || total > 16 * 1024 * 1024) throw new Error('corrupt event-stream frame');
      if (this.buf.length < total) break;
      const headers = decodeHeaders(this.buf.subarray(12, 12 + headersLen));
      const payload = this.buf.slice(12 + headersLen, total - 4);
      out.push({ headers, payload });
      this.buf = this.buf.slice(total);
    }
    return out;
  }
}

function decodeHeaders(b: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const td = new TextDecoder();
  let i = 0;
  while (i < b.length) {
    const nameLen = b[i]!;
    i += 1;
    const name = td.decode(b.subarray(i, i + nameLen));
    i += nameLen;
    const type = b[i]!;
    i += 1;
    switch (type) {
      case 0:
      case 1:
        out[name] = type === 0 ? 'true' : 'false';
        break;
      case 2:
        out[name] = String(dv.getInt8(i));
        i += 1;
        break;
      case 3:
        out[name] = String(dv.getInt16(i));
        i += 2;
        break;
      case 4:
        out[name] = String(dv.getInt32(i));
        i += 4;
        break;
      case 5:
      case 8:
        out[name] = String(dv.getBigInt64(i));
        i += 8;
        break;
      case 6:
      case 7: {
        const len = dv.getUint16(i);
        i += 2;
        out[name] = type === 7 ? td.decode(b.subarray(i, i + len)) : '';
        i += len;
        break;
      }
      case 9:
        i += 16;
        break;
      default:
        return out;
    }
  }
  return out;
}

/** Encode one event-stream frame (tests + fixtures). CRC fields are written as 0. */
export function encodeAwsEvent(headers: Record<string, string>, payload: string): Uint8Array {
  const hb: number[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const kn = te.encode(k);
    const vb = te.encode(v);
    hb.push(kn.length, ...kn, 7, (vb.length >> 8) & 0xff, vb.length & 0xff, ...vb);
  }
  const pb = te.encode(payload);
  const total = 12 + hb.length + pb.length + 4;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total);
  dv.setUint32(4, hb.length);
  out.set(hb, 12);
  out.set(pb, 12 + hb.length);
  return out;
}
