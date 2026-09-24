import { describe, expect, it } from 'bun:test';
import { AuthOriginError, isOriginRejection } from './auth-origin-error';

describe('origin rejection (QA-001)', () => {
  it("recognises Better Auth's INVALID_ORIGIN by code or message", () => {
    expect(isOriginRejection({ code: 'INVALID_ORIGIN', message: 'Invalid origin' })).toBe(true);
    expect(isOriginRejection({ message: 'Invalid origin' })).toBe(true);
    expect(isOriginRejection({ code: 'INVALID_USERNAME_OR_PASSWORD', message: 'Invalid username or password' })).toBe(false);
  });
  it('names the refused origin', () => {
    const e = new AuthOriginError('http://10.0.0.5:3021');
    expect(e.message).toContain('http://10.0.0.5:3021');
    expect(e.origin).toBe('http://10.0.0.5:3021');
  });
});
