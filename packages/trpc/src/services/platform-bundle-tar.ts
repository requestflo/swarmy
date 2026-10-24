/**
 * A read-only index over a POSIX tar (the offline platform bundle,
 * `scripts/platform-bundle.ts`): entry name → byte range. Nothing is
 * extracted — a multi-GB bundle stays one file on disk and each blob is read
 * (or streamed to the registry) straight from its range.
 *
 * Understands ustar (name + prefix), pax extended headers (`path`, `size`)
 * and GNU long names, which is what GNU tar and bsdtar write. Directories,
 * links and devices are skipped.
 */

export interface TarEntry {
  name: string;
  offset: number;
  size: number;
}

/** Read `length` bytes at `offset` (a file slice in production, a buffer in tests). */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

const BLOCK = 512;
const dec = new TextDecoder();

function cstr(b: Uint8Array, start: number, len: number): string {
  const s = b.subarray(start, start + len);
  const end = s.indexOf(0);
  return dec.decode(end >= 0 ? s.subarray(0, end) : s);
}

/** Header size field: octal text, or base-256 (high bit set) for entries over 8 GiB. */
export function tarSize(field: Uint8Array): number {
  if ((field[0] ?? 0) & 0x80) {
    let n = (field[0] ?? 0) & 0x7f;
    for (let i = 1; i < field.length; i++) n = n * 256 + (field[i] ?? 0);
    return n;
  }
  const t = dec.decode(field).replace(/[\0 ]+/g, '');
  if (!/^[0-7]*$/.test(t)) return Number.NaN;
  return t ? Number.parseInt(t, 8) : 0;
}

/** Pax records (`<len> key=value\n`) → key/value. */
export function paxRecords(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of dec.decode(data).split('\n')) {
    const m = /^\d+ ([^=]+)=(.*)$/s.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function clean(name: string): string {
  return name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

/** Index every regular file in the archive. Throws on a file that is not a tar. */
export async function indexTar(read: ReadAt, total: number): Promise<Map<string, TarEntry>> {
  const out = new Map<string, TarEntry>();
  let pos = 0;
  let longName: string | null = null;
  let pax: Record<string, string> = {};
  while (pos + BLOCK <= total) {
    const h = await read(pos, BLOCK);
    if (h.every((x) => x === 0)) break;
    const type = String.fromCharCode(h[156] ?? 0);
    let size = tarSize(h.subarray(124, 136));
    // A pax `size` describes the entry AFTER the pax header, never a header itself.
    if (type !== 'x' && type !== 'g' && type !== 'L' && pax.size && /^\d+$/.test(pax.size)) size = Number(pax.size);
    if (!Number.isFinite(size) || size < 0) throw new Error(`not a tar file (bad header at byte ${pos})`);
    const data = pos + BLOCK;
    const next = data + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      pax = paxRecords(await read(data, size));
    } else if (type === 'L') {
      longName = cstr(await read(data, size), 0, size);
    } else if (type === 'g') {
      // global pax header: nothing we need
    } else {
      if (type === '0' || type === '\0' || type === '7') {
        const prefix = cstr(h, 257, 6).startsWith('ustar') ? cstr(h, 345, 155) : '';
        const base = cstr(h, 0, 100);
        const name = clean(pax.path ?? longName ?? (prefix ? `${prefix}/${base}` : base));
        if (data + size > total) throw new Error(`the bundle is truncated (${name} runs past the end)`);
        out.set(name, { name, offset: data, size });
      }
      longName = null;
      pax = {};
    }
    pos = next;
  }
  return out;
}

/** An entry by its path inside the bundle, with or without the `swarmy-bundle/` top directory. */
export function bundleEntry(entries: ReadonlyMap<string, TarEntry>, rel: string): TarEntry | undefined {
  return entries.get(`swarmy-bundle/${rel}`) ?? entries.get(rel);
}
