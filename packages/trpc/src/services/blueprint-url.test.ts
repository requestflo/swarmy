import { describe, expect, test } from 'bun:test';
import { blueprintUrl } from './blueprints.service';

describe('blueprintUrl (QA-005)', () => {
  test('no domain: the stamped auto sslip address', () => {
    expect(blueprintUrl({ routedUrl: null, autoHost: 'web-shop.46-101-22-121.sslip.io', ok: true })).toBe(
      'https://web-shop.46-101-22-121.sslip.io',
    );
  });
  test('an explicit domain route wins', () => {
    expect(blueprintUrl({ routedUrl: 'https://shop.example.com', autoHost: null, ok: true })).toBe('https://shop.example.com');
  });
  test('a failed deploy, or no address at all (tunnel / no edge IP), is null', () => {
    expect(blueprintUrl({ routedUrl: null, autoHost: 'x.sslip.io', ok: false })).toBeNull();
    expect(blueprintUrl({ routedUrl: null, autoHost: null, ok: true })).toBeNull();
  });
});
