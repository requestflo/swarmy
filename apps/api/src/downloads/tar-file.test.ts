import { describe, expect, it } from 'bun:test';
import { fileAsTar, tarFileHead, tarFileTail } from './tar-file';

const dec = new TextDecoder();
const field = (b: Uint8Array, off: number, len: number) => dec.decode(b.subarray(off, off + len)).replace(/\0.*$/s, '');

function checksumOk(h: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  return Number.parseInt(field(h, 148, 7), 8) === sum;
}

async function tarOf(name: string, data: Uint8Array): Promise<Uint8Array> {
  const src = new Blob([data]).stream().pipeThrough(fileAsTar({ name, size: data.byteLength, mtimeMs: 1_700_000_000_000 }));
  return new Uint8Array(await new Response(src).arrayBuffer());
}

/** List with the system tar when there is one (the real reader is the golden). */
async function systemTarList(tar: Uint8Array): Promise<string | null> {
  if (!Bun.which('tar')) return null;
  const p = Bun.spawn(['tar', '-tvf', '-'], { stdin: tar, stdout: 'pipe', stderr: 'pipe' });
  return (await p.exited) === 0 ? await new Response(p.stdout).text() : `ERR ${await new Response(p.stderr).text()}`;
}

describe('one-file tar', () => {
  it('writes a ustar header with a valid checksum, padding and the end marker', async () => {
    const tar = await tarOf('data/a.txt', new TextEncoder().encode('hello\n'));
    expect(tar.byteLength).toBe(512 + 512 + 1024);
    expect(field(tar, 0, 100)).toBe('data/a.txt');
    expect(Number.parseInt(field(tar, 124, 12), 8)).toBe(6);
    expect(field(tar, 257, 6)).toBe('ustar');
    expect(checksumOk(tar)).toBe(true);
    expect(dec.decode(tar.subarray(512, 518))).toBe('hello\n');
    expect(tar.subarray(518).every((x) => x === 0)).toBe(true);
    const listed = await systemTarList(tar);
    if (listed !== null) expect(listed).toContain('data/a.txt');
  });

  it('a long or non-ASCII name rides a PAX header the system tar understands', async () => {
    const name = `data/${'ünï cøde/'.repeat(12)}file.txt`;
    const head = tarFileHead({ name, size: 3, mtimeMs: 0 });
    expect(String.fromCharCode(head[156]!)).toBe('x');
    expect(checksumOk(head)).toBe(true);
    expect(checksumOk(head.subarray(head.length - 512))).toBe(true);
    expect(dec.decode(head)).toContain(` path=${name}\n`);
    const listed = await systemTarList(await tarOf(name, new Uint8Array([1, 2, 3])));
    if (listed !== null) expect(listed.normalize('NFC')).toContain(name);
  });

  it('carries a size past ustar’s 8 GiB field in PAX', () => {
    const head = tarFileHead({ name: 'data/big', size: 9 * 1024 ** 3, mtimeMs: 0 });
    expect(dec.decode(head)).toContain(` size=${9 * 1024 ** 3}\n`);
    expect(tarFileTail(9 * 1024 ** 3).byteLength).toBe(1024);
  });

  it('PAX record lengths count themselves, across a digit boundary', () => {
    for (const n of [80, 85, 90, 95, 96, 97, 98, 990]) {
      const head = tarFileHead({ name: `data/${'x'.repeat(n)}é`, size: 1, mtimeMs: 0 });
      const record = head.subarray(512, 512 + Number.parseInt(field(head, 124, 12), 8));
      expect(record.byteLength).toBe(Number.parseInt(dec.decode(record), 10));
    }
  });

  it('errors when the stream is shorter or longer than the saved size', async () => {
    const short = new Blob([new Uint8Array(2)]).stream().pipeThrough(fileAsTar({ name: 'a', size: 3, mtimeMs: 0 }));
    await expect(new Response(short).arrayBuffer()).rejects.toThrow('ended at 2 of 3');
    const long = new Blob([new Uint8Array(4)]).stream().pipeThrough(fileAsTar({ name: 'a', size: 3, mtimeMs: 0 }));
    await expect(new Response(long).arrayBuffer()).rejects.toThrow('grew past');
  });
});
