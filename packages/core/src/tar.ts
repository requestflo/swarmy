/**
 * A strict, minimal POSIX tar reader + writer for image archives a node loads
 * with `docker load` (`image-archive.ts`). The reader is for archives that
 * must hold ONLY what was verified: it indexes regular files and directories
 * and THROWS on anything `docker load` could resolve differently from what we
 * hashed — links, devices, duplicate names, absolute or `..` paths. (The
 * offline-bundle reader in trpc, `platform-bundle-tar.ts`, is the lenient one.)
 *
 * The writer emits plain ustar (names up to 100 bytes, which `blobs/sha256/<hex>`
 * fits). Pure; tested in image-archive.test.ts.
 */

export interface TarFile {
  name: string;
  offset: number;
  size: number;
}

/** Read `length` bytes at `offset` (a file slice on the node, a buffer in tests). */
export type TarReadAt = (offset: number, length: number) => Promise<Uint8Array>;

const BLOCK = 512;
const enc = new TextEncoder();
const dec = new TextDecoder();

function field(h: Uint8Array, start: number, len: number): string {
  const s = h.subarray(start, start + len);
  const end = s.indexOf(0);
  return dec.decode(end >= 0 ? s.subarray(0, end) : s);
}

function octal(h: Uint8Array, start: number, len: number): number {
  const t = field(h, start, len).trim();
  return /^[0-7]+$/.test(t) ? Number.parseInt(t, 8) : Number.NaN;
}

/** Index every regular file; throw on any member that is not a plain file or directory. */
export async function indexTarStrict(read: TarReadAt, total: number): Promise<Map<string, TarFile>> {
  const out = new Map<string, TarFile>();
  for (let pos = 0; pos + BLOCK <= total; ) {
    const h = await read(pos, BLOCK);
    if (h.every((b) => b === 0)) break;
    const type = String.fromCharCode(h[156] ?? 0);
    const size = octal(h, 124, 12);
    if (!Number.isFinite(size) || size < 0) throw new Error(`not a tar archive (bad header at byte ${pos})`);
    const prefix = field(h, 257, 6).startsWith('ustar') ? field(h, 345, 155) : '';
    const raw = prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100);
    const name = raw.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (type !== '5' && type !== '0' && type !== '\0') throw new Error(`the archive holds a link or special file (${raw})`);
    if (raw.startsWith('/') || name.split('/').includes('..')) throw new Error(`unsafe path in the archive (${raw})`);
    const data = pos + BLOCK;
    if (type !== '5') {
      if (data + size > total) throw new Error(`the archive is truncated (${name})`);
      if (out.has(name)) throw new Error(`the archive holds ${name} twice`);
      out.set(name, { name, offset: data, size });
    }
    pos = data + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

function header(name: string, size: number): Uint8Array {
  if (enc.encode(name).length > 100) throw new Error(`tar name too long: ${name}`);
  const h = new Uint8Array(BLOCK);
  h.set(enc.encode(name), 0);
  h.set(enc.encode('0000644\0'), 100);
  h.set(enc.encode('0000000\0'), 108);
  h.set(enc.encode('0000000\0'), 116);
  h.set(enc.encode(`${size.toString(8).padStart(11, '0')}\0`), 124);
  h.set(enc.encode('00000000000\0'), 136);
  h.set(enc.encode('0'), 156);
  h.set(enc.encode('ustar\x0000'), 257);
  h.set(enc.encode('        '), 148);
  const sum = h.reduce((a, b) => a + b, 0);
  h.set(enc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
  return h;
}

/** A ustar archive of `files` (regular files only), in order. */
export function writeTar(files: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, body] of files) {
    parts.push(header(name, body.length), body, new Uint8Array((BLOCK - (body.length % BLOCK)) % BLOCK));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
