import { describe, expect, it } from 'bun:test';
import type { ImageSignatureView } from '@swarmy/core';
import { agoWords, signChipWords } from './sign-chip-model';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const D = `sha256:${'ab'.repeat(32)}`;
const v = (over: Partial<ImageSignatureView>): ImageSignatureView => ({
  service: 'storefront_api',
  image: `localhost:5000/northwind-api:main@${D}`,
  digest: D,
  state: 'swarmy',
  source: 'admission',
  checkedAt: '2026-10-26T10:00:00Z',
  ...over,
});

describe('signChipWords', () => {
  it('signed by the workspace key: when it was checked, or when the build signed it', () => {
    expect(signChipWords(v({}), NOW)).toEqual({
      label: 'signed',
      tone: 'ok',
      reason: 'Signed with your workspace’s own key, the one swarmy signs every build with; checked when it was deployed, 2 hours ago.',
      tech: 'cosign · sha256:ababab…abab · workspace key · verified at deploy',
    });
    expect(signChipWords(v({ source: 'build' }), NOW).reason).toContain('swarmy’s build signed it 2 hours ago');
  });

  it('a trusted key is named', () => {
    const w = signChipWords(v({ state: 'trusted', keyName: 'Acme release' }), NOW);
    expect(w.label).toBe('signed · trusted key');
    expect(w.reason).toBe('Signed with “Acme release”, a key you trust; checked when it was deployed, 2 hours ago.');
    expect(w.tech).toBe('cosign · sha256:ababab…abab · trusted key Acme release · verified at deploy');
  });

  it('unsigned is amber, said plainly', () => {
    const w = signChipWords(v({ state: 'unsigned' }), NOW);
    expect([w.label, w.tone]).toEqual(['unsigned', 'warn']);
    expect(w.reason).toBe('No valid signature from your key or any key you trust; checked when it was deployed, 2 hours ago.');
  });

  it('not checked always says why, never guesses', () => {
    const hub = signChipWords(v({ state: 'unchecked', why: 'third-party', image: 'postgres:16' }), NOW);
    expect([hub.label, hub.tone]).toEqual(['not checked', 'idle']);
    expect(hub.reason).toContain('comes from docker.io');
    const tag = signChipWords(v({ state: 'unchecked', why: 'not-pinned', image: 'localhost:5000/web:main', digest: null }), NOW);
    expect(tag.reason).toContain('runs the tag “main”');
    const never = signChipWords(v({ state: 'unchecked', why: 'never-checked' }), NOW);
    expect(never.reason).toStartWith('Not checked yet.');
    expect(never.tech).toBe('sha256:ababab…abab · no signature check on record');
  });
});

describe('agoWords', () => {
  it('says time in words, and never invents one', () => {
    expect(agoWords('2026-10-26T11:59:40Z', NOW)).toBe('just now');
    expect(agoWords('2026-10-26T11:59:00Z', NOW)).toBe('1 minute ago');
    expect(agoWords('2026-10-25T12:00:00Z', NOW)).toBe('24 hours ago');
    expect(agoWords('2026-10-20T12:00:00Z', NOW)).toBe('6 days ago');
    expect(agoWords(undefined, NOW)).toBe('at some point');
  });
});
