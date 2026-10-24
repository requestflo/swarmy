import { describe, expect, it } from 'bun:test';
import { isBroadWildcard } from './wildcard-scope';

describe('isBroadWildcard (a wildcard must stay inside one registrable domain)', () => {
  it('refuses wildcards over a public suffix', () => {
    for (const h of [
      '*.com',
      '*.io',
      '*.co.uk',
      '*.com.au',
      '*.gov.uk',
      '*.or.jp',
      '*.github.io',
      '*.sslip.io',
      '*.*.com',
      '*.',
      '*',
      '*.COM.',
    ]) {
      expect(isBroadWildcard(h)).toBe(true);
    }
  });

  it('allows a wildcard under a registrable domain, and never flags exact hosts', () => {
    for (const h of [
      '*.acme.com',
      '*.apps.acme.com',
      '*.shop.co.uk',
      '*.me.github.io',
      '*.46-101-22-121.sslip.io',
      'com',
      'acme.com',
    ]) {
      expect(isBroadWildcard(h)).toBe(false);
    }
  });
});
