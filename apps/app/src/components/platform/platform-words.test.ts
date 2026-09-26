import { describe, expect, it } from 'bun:test';
import { checkIsStale, checkedWords, upgradePrereq } from './platform-words';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe('checkedWords', () => {
  it('says when the feed was last checked', () => {
    expect(checkedWords(minsAgo(0.2), null, NOW)).toBe('Checked just now');
    expect(checkedWords(minsAgo(12), null, NOW)).toBe('Checked 12 min ago');
    expect(checkedWords(minsAgo(180), null, NOW)).toBe('Checked 3 h ago');
    expect(checkedWords(minsAgo(60 * 24), null, NOW)).toBe('Checked 1 day ago');
  });
  it('says when it never checked, or the check failed', () => {
    expect(checkedWords(null, null, NOW)).toBe('Never checked');
    expect(checkedWords(new Date(0).toISOString(), null, NOW)).toBe('Never checked');
    expect(checkedWords(minsAgo(120), 'ENOTFOUND', NOW)).toBe('The last check failed 2 h ago');
  });
});

describe('checkIsStale', () => {
  it('re-checks when never checked or older than 10 minutes', () => {
    expect(checkIsStale(null, NOW)).toBe(true);
    expect(checkIsStale(minsAgo(11), NOW)).toBe(true);
    expect(checkIsStale(minsAgo(9), NOW)).toBe(false);
  });
});

describe('upgradePrereq', () => {
  it('asks for the backup passphrase before the first upgrade', () => {
    expect(upgradePrereq({ hasPassphrase: false })).toBe('passphrase');
    expect(upgradePrereq({ hasPassphrase: true })).toBeNull();
    expect(upgradePrereq(undefined)).toBeNull();
  });
});
