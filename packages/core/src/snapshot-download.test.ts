import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_DOWNLOAD_MAX_BYTES,
  bytesWords,
  checkSnapshotPath,
  contentDisposition,
  downloadFileName,
  parseDownloadMaxBytes,
  relSnapshotPath,
  tooLargeWords,
} from './snapshot-download';

describe('checkSnapshotPath (the path stays inside the save)', () => {
  it('maps a volume-relative path, with or without slashes, onto /data', () => {
    expect(checkSnapshotPath('config/app.yml')).toEqual({ ok: true, rel: 'config/app.yml', abs: '/data/config/app.yml' });
    expect(checkSnapshotPath('/config//app.yml/')).toEqual({ ok: true, rel: 'config/app.yml', abs: '/data/config/app.yml' });
    expect(checkSnapshotPath('')).toEqual({ ok: true, rel: '', abs: '/data' });
    expect(checkSnapshotPath('  /  ')).toEqual({ ok: true, rel: '', abs: '/data' });
    expect(checkSnapshotPath('ünï cøde.txt')).toMatchObject({ ok: true, abs: '/data/ünï cøde.txt' });
    expect(checkSnapshotPath('.env')).toMatchObject({ ok: true, abs: '/data/.env' });
  });

  it('refuses .. and . instead of resolving them', () => {
    for (const p of ['..', '../etc/passwd', 'a/../../b', 'a/./b', './a', 'a/..']) {
      expect(checkSnapshotPath(p).ok).toBe(false);
    }
  });

  it('refuses control characters (no header or argv smuggling)', () => {
    expect(checkSnapshotPath('a\nb').ok).toBe(false);
    expect(checkSnapshotPath('a\u0000').ok).toBe(false);
    expect(checkSnapshotPath('a\rb').ok).toBe(false);
  });

  it('round-trips back to the volume-relative form', () => {
    expect(relSnapshotPath('/data/a/b')).toBe('a/b');
    expect(relSnapshotPath('/data')).toBe('');
  });
});

describe('downloadFileName / contentDisposition', () => {
  const savedAt = new Date('2026-10-27T03:02:59Z');
  it('names the volume, the path and when it was saved, as safe ASCII', () => {
    expect(downloadFileName({ volume: 'shop_uploads', rel: 'img/2026', savedAt })).toBe('shop_uploads-img_2026-20261027-0302.tar.gz');
    expect(downloadFileName({ volume: 'shop_uploads', rel: '', savedAt })).toBe('shop_uploads-20261027-0302.tar.gz');
  });
  it('folds quotes, separators, newlines, dots-first and non-ASCII away', () => {
    const name = downloadFileName({ volume: 'v', rel: '../"evil"\r\nSet-Cookie: x/ünï.txt', savedAt });
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(name).not.toContain('..');
    expect(name.startsWith('v-')).toBe(true);
  });
  it('caps the length', () => {
    expect(downloadFileName({ volume: 'v', rel: 'x'.repeat(500), savedAt }).length).toBeLessThanOrEqual(150);
  });
  it('builds a header with no way to break out of the quotes', () => {
    expect(contentDisposition('a.tar.gz')).toBe(`attachment; filename="a.tar.gz"; filename*=UTF-8''a.tar.gz`);
    const h = contentDisposition('ü"\\\n.tar.gz');
    expect(h).not.toContain('\n');
    expect(h.split('"').length).toBe(3);
  });
});

describe('the download cap', () => {
  it('defaults to 2 GiB and parses bytes or binary suffixes', () => {
    expect(parseDownloadMaxBytes(undefined)).toBe(DEFAULT_DOWNLOAD_MAX_BYTES);
    expect(DEFAULT_DOWNLOAD_MAX_BYTES).toBe(2_147_483_648);
    expect(parseDownloadMaxBytes('1048576')).toBe(1_048_576);
    expect(parseDownloadMaxBytes('500M')).toBe(500 * 1024 ** 2);
    expect(parseDownloadMaxBytes('10GiB')).toBe(10 * 1024 ** 3);
    expect(parseDownloadMaxBytes('1.5g')).toBe(1.5 * 1024 ** 3);
  });
  it('falls back to the default on junk or zero', () => {
    for (const raw of ['', 'lots', '0', '-5', '5X']) expect(parseDownloadMaxBytes(raw)).toBe(DEFAULT_DOWNLOAD_MAX_BYTES);
  });
  it('says the size, the limit, where it is set and the way out', () => {
    expect(tooLargeWords(DEFAULT_DOWNLOAD_MAX_BYTES, 3.4 * 1024 ** 3)).toBe(
      'It’s 3.4 GB, and downloads stop at 2 GB (SWARMY_BACKUP_DOWNLOAD_MAX_BYTES on the controller). Restore the save into a new volume instead, or download a smaller folder.',
    );
    expect(tooLargeWords(1024 ** 2)).toContain('passed the limit: downloads stop at 1 MB');
  });
  it('words bytes like the Backups page', () => {
    expect(bytesWords(0)).toBe('0 B');
    expect(bytesWords(1536)).toBe('1.5 KB');
    expect(bytesWords(2 * 1024 ** 3)).toBe('2 GB');
  });
});
