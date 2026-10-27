import { describe, expect, it } from 'bun:test';
import { copyLagLine, lagWords, type CopyLag } from './copy-lag-words';

const lag = (over: Partial<CopyLag> = {}): CopyLag => ({
  targetId: 'b2',
  schedules: 4,
  databases: 0,
  behindMs: 4 * 60_000,
  worstVolume: 'shop_db',
  neverCopied: 0,
  copying: 0,
  failing: 0,
  lastError: null,
  newestCopyAt: '2026-10-25T03:12:00.000Z',
  copiedBytes: String(212 * 1024 ** 3),
  ...over,
});

describe('copyLagLine', () => {
  it('how far behind, with where it is at Controls', () => {
    expect(copyLagLine(lag())).toEqual({
      say: 'Second copy · 4 min behind',
      tone: 'ok',
      tech: 'also copy to · 4 schedules · newest copy 2026-10-25 03:12 UTC · 212.0 GB',
    });
    expect(copyLagLine(lag({ behindMs: 0 })).say).toBe('Second copy · up to date');
    expect(copyLagLine(lag({ behindMs: 0, copying: 2 })).say).toBe('Second copy · up to date · copying now');
  });

  it('a missed nightly copy is a warning; a failed one is bad and says why', () => {
    expect(copyLagLine(lag({ behindMs: 30 * 3_600_000 }))).toMatchObject({ say: 'Second copy · 30 h behind', tone: 'warn' });
    const failed = copyLagLine(lag({ failing: 1, lastError: 'AccessDenied' }));
    expect(failed).toMatchObject({ say: 'Second copy · the last copy of 1 volume failed', tone: 'bad' });
    expect(failed.tech).toContain('last error: AccessDenied');
  });

  it('says databases when database schedules copy here too', () => {
    expect(copyLagLine(lag({ databases: 4, failing: 1 })).say).toBe('Second copy · the last copy of 1 database failed');
    expect(copyLagLine(lag({ databases: 1, neverCopied: 2 })).say).toBe('Second copy · 2 volumes or databases not copied yet');
  });

  it('nothing copied yet, or nothing saved yet', () => {
    expect(copyLagLine(lag({ neverCopied: 2 })).say).toBe('Second copy · 2 volumes not copied yet');
    expect(copyLagLine(lag({ behindMs: null, newestCopyAt: null, copiedBytes: '0' }))).toEqual({ say: 'Second copy · nothing saved yet', tone: 'idle', tech: 'also copy to · 4 schedules' });
  });

  it('lagWords rounds to minutes, hours, then days', () => {
    expect(lagWords(10_000)).toBe('1 min');
    expect(lagWords(3 * 3_600_000)).toBe('3 h');
    expect(lagWords(3 * 86_400_000)).toBe('3 days');
  });
});
