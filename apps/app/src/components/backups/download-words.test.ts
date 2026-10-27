import { describe, expect, it } from 'bun:test';
import { folderCrumbs, isFinished, pickWords, sizeWords, statusWords } from './download-words';

const CAP = String(2 * 1024 ** 3);

describe('folderCrumbs', () => {
  it('walks back to the volume', () => {
    expect(folderCrumbs('img/2026', 'uploads')).toEqual([
      { name: 'uploads', path: '' },
      { name: 'img', path: 'img' },
      { name: '2026', path: 'img/2026' },
    ]);
    expect(folderCrumbs('', 'uploads')).toEqual([{ name: 'uploads', path: '' }]);
  });
});

describe('pickWords', () => {
  it('a file says its size; a folder says the size comes as it downloads, with the cap', () => {
    expect(pickWords({ path: 'a.txt', type: 'file', sizeBytes: '1536' }, CAP)).toEqual({ text: 'a.txt · 1.5 KB', tone: 'idle', ok: true });
    expect(pickWords({ path: 'img', type: 'dir', sizeBytes: null }, CAP).text).toBe('img/ · a folder, so its size shows as it downloads (up to 2 GB)');
    expect(pickWords({ path: '', type: 'dir', sizeBytes: null }, CAP).text).toContain('The whole volume · a folder');
    expect(pickWords({ path: 'etc/x', type: 'typed', sizeBytes: null }, CAP).text).toBe('etc/x · swarmy checks what it is when you download (up to 2 GB)');
  });
  it('a file past the cap can’t be picked, and says what to do instead', () => {
    expect(pickWords({ path: 'db.bin', type: 'file', sizeBytes: String(3 * 1024 ** 3) }, CAP)).toEqual({
      text: 'db.bin is 3 GB; downloads stop at 2 GB. Restore the save into a new volume instead.',
      tone: 'warn',
      ok: false,
    });
  });
});

describe('statusWords', () => {
  it('follows the download from start to end', () => {
    expect(statusWords(null, 'x.tar.gz')).toBeNull();
    expect(statusWords({ state: 'ready', bytes: 0, error: null }, 'x.tar.gz')).toEqual({ text: 'Starting x.tar.gz…', tone: 'info' });
    expect(statusWords({ state: 'streaming', bytes: 0, error: null }, 'x.tar.gz')!.text).toBe('Reading the save for x.tar.gz…');
    expect(statusWords({ state: 'streaming', bytes: 5 * 1024 ** 2, error: null }, 'x.tar.gz')!.text).toBe('Downloading x.tar.gz · 5 MB so far');
    expect(statusWords({ state: 'done', bytes: 1024, error: null }, 'x.tar.gz')).toEqual({ text: 'Downloaded x.tar.gz · 1 KB read from the save', tone: 'ok' });
    expect(statusWords({ state: 'failed', bytes: 0, error: 'That path isn’t in this save.' }, 'x')).toEqual({ text: 'That path isn’t in this save.', tone: 'bad' });
  });
  it('knows when to stop polling', () => {
    expect(isFinished({ state: 'streaming', bytes: 0, error: null })).toBe(false);
    expect(isFinished({ state: 'canceled', bytes: 0, error: null })).toBe(true);
    expect(sizeWords(null)).toBe('');
  });
});
