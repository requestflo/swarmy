import { describe, expect, it } from 'bun:test';
import { bundleEntry, indexTar, paxRecords, tarSize } from './platform-bundle-tar';
import { bytes, tarOf } from './platform-bundle.test-data';

const reader = (t: Uint8Array) => async (o: number, n: number) => t.subarray(o, o + n);
const text = async (t: Uint8Array, e: { offset: number; size: number } | undefined) =>
  e ? new TextDecoder().decode(t.subarray(e.offset, e.offset + e.size)) : undefined;

const BLOB = `swarmy-bundle/oci/blobs/sha256/${'a'.repeat(64)}`;
const LONG = `swarmy-bundle/${'deep/'.repeat(25)}file.json`;

describe('indexTar: the bundle is read in place, never extracted', () => {
  it('indexes regular files with their byte ranges', async () => {
    const t = tarOf([
      ['swarmy-bundle/platform.json', '{"v":1}'],
      ['swarmy-bundle/platform.json.sig', 'c2ln'],
      [BLOB, 'x'.repeat(1300)],
    ]);
    const idx = await indexTar(reader(t), t.length);
    expect([...idx.keys()]).toEqual(['swarmy-bundle/platform.json', 'swarmy-bundle/platform.json.sig', BLOB]);
    expect(await text(t, idx.get('swarmy-bundle/platform.json'))).toBe('{"v":1}');
    expect(idx.get(BLOB)?.size).toBe(1300);
    expect(await text(t, idx.get(BLOB))).toBe('x'.repeat(1300));
  });

  it('takes long names from a pax path record (GNU tar / bsdtar) or a GNU long-name entry', async () => {
    for (const longNames of ['pax', 'gnu'] as const) {
      const t = tarOf([[LONG, 'deep'], ['swarmy-bundle/after', 'next']], { longNames });
      const idx = await indexTar(reader(t), t.length);
      expect(await text(t, idx.get(LONG))).toBe('deep');
      // The long name applies to ONE entry only.
      expect(await text(t, idx.get('swarmy-bundle/after'))).toBe('next');
    }
  });

  it('finds entries with or without the swarmy-bundle/ top directory, and strips ./', async () => {
    const t = tarOf([['./platform.json', 'flat']]);
    const idx = await indexTar(reader(t), t.length);
    expect(await text(t, bundleEntry(idx, 'platform.json'))).toBe('flat');
    expect(bundleEntry(idx, 'platform.json.sig')).toBeUndefined();
  });

  it('refuses a file that is not a tar, and a truncated one', async () => {
    const junk = new Uint8Array(1024).fill(0x41);
    await expect(indexTar(reader(junk), junk.length)).rejects.toThrow(/not a tar file/);
    const t = tarOf([[BLOB, 'y'.repeat(4000)]]);
    const cut = t.subarray(0, 2048);
    await expect(indexTar(reader(cut), cut.length)).rejects.toThrow(/truncated/);
  });
});

describe('tar header fields', () => {
  it('size: octal text, and base-256 for entries over 8 GiB', () => {
    expect(tarSize(bytes('00000002000\0'))).toBe(1024);
    const big = new Uint8Array(12);
    big[0] = 0x80;
    big[7] = 0x02; // 2 << 32 = 8 GiB
    expect(tarSize(big)).toBe(2 ** 33);
  });

  it('pax records', () => {
    expect(paxRecords(bytes('30 path=swarmy-bundle/a.json\n20 size=123456789\n'))).toEqual({
      path: 'swarmy-bundle/a.json',
      size: '123456789',
    });
  });
});
