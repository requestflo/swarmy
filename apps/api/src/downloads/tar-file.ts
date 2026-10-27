/**
 * A one-file tar around a byte stream (a single-file download: restic dumps a
 * file as its bare bytes, and the download is always a .tar.gz). POSIX ustar,
 * with a PAX header when the name isn't short ASCII or the size passes ustar's
 * 8 GiB field. Pure, except the TransformStream at the end.
 */

const BLOCK = 512;
const USTAR_MAX_SIZE = 0o77777777777;
const enc = new TextEncoder();

function put(b: Uint8Array, off: number, len: number, s: string): void {
  b.set(enc.encode(s).subarray(0, len), off);
}

function octal(b: Uint8Array, off: number, len: number, n: number): void {
  put(b, off, len - 1, Math.floor(n).toString(8).padStart(len - 1, '0'));
}

function header(name: string, size: number, mtimeMs: number, mode: number, type: '0' | 'x'): Uint8Array {
  const b = new Uint8Array(BLOCK);
  put(b, 0, 100, name);
  octal(b, 100, 8, mode);
  octal(b, 108, 8, 0);
  octal(b, 116, 8, 0);
  octal(b, 124, 12, size);
  octal(b, 136, 12, mtimeMs / 1000);
  b.fill(0x20, 148, 156);
  b[156] = type.charCodeAt(0);
  put(b, 257, 6, 'ustar');
  put(b, 263, 2, '00');
  put(b, 265, 32, 'root');
  put(b, 297, 32, 'root');
  let sum = 0;
  for (const x of b) sum += x;
  put(b, 148, 7, `${sum.toString(8).padStart(6, '0')}\0`);
  return b;
}

/** One PAX record: `<len> <key>=<value>\n`, where len counts itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLen = enc.encode(body).length;
  const digits = String(bodyLen).length;
  let len = bodyLen + digits;
  if (String(len).length > digits) len += 1;
  return `${len}${body}`;
}

const padTo = (n: number): number => (BLOCK - (n % BLOCK)) % BLOCK;

/** Everything before the file's bytes: [PAX header + records +] the ustar header. */
export function tarFileHead(e: { name: string; size: number; mtimeMs: number; mode?: number }): Uint8Array {
  const mode = e.mode ?? 0o644;
  const shortAscii = /^[\x20-\x7e]{1,99}$/.test(e.name);
  const fitsSize = e.size <= USTAR_MAX_SIZE;
  if (shortAscii && fitsSize) return header(e.name, e.size, e.mtimeMs, mode, '0');
  const records = enc.encode((shortAscii ? '' : paxRecord('path', e.name)) + (fitsSize ? '' : paxRecord('size', String(e.size))));
  const fallback = e.name.replace(/[^\x20-\x7e]/g, '_').slice(-99);
  const out = new Uint8Array(BLOCK + records.length + padTo(records.length) + BLOCK);
  out.set(header('PaxHeader', records.length, e.mtimeMs, 0o644, 'x'), 0);
  out.set(records, BLOCK);
  out.set(header(fallback, fitsSize ? e.size : 0, e.mtimeMs, mode, '0'), out.length - BLOCK);
  return out;
}

/** Everything after the file's bytes: padding to a block, then the two-block end marker. */
export function tarFileTail(size: number): Uint8Array {
  return new Uint8Array(padTo(size) + 2 * BLOCK);
}

/** Wrap a byte stream of exactly `size` bytes as a one-file tar; a short or long stream errors. */
export function fileAsTar(e: { name: string; size: number; mtimeMs: number }): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    start: (c) => c.enqueue(tarFileHead(e)),
    transform: (chunk, c) => {
      seen += chunk.byteLength;
      if (seen > e.size) return c.error(new Error(`the file grew past its saved size (${e.size} bytes)`));
      c.enqueue(chunk);
    },
    flush: (c) => {
      if (seen !== e.size) return c.error(new Error(`the file ended at ${seen} of ${e.size} bytes`));
      c.enqueue(tarFileTail(e.size));
    },
  });
}
