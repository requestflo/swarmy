import { describe, expect, it } from 'bun:test';
import { MAX_IDEMPOTENCY_KEY_LENGTH, normalizeIdempotencyKey } from './idempotency';

describe('normalizeIdempotencyKey', () => {
  it('returns null for absent header', () => {
    expect(normalizeIdempotencyKey(undefined)).toBeNull();
    expect(normalizeIdempotencyKey(null)).toBeNull();
  });

  it('returns null for blank / whitespace-only values', () => {
    expect(normalizeIdempotencyKey('')).toBeNull();
    expect(normalizeIdempotencyKey('   ')).toBeNull();
    expect(normalizeIdempotencyKey('\t\n')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeIdempotencyKey('  abc-123  ')).toBe('abc-123');
    expect(normalizeIdempotencyKey('\tkey\n')).toBe('key');
  });

  it('preserves a normal key verbatim', () => {
    expect(normalizeIdempotencyKey('550e8400-e29b-41d4-a716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it('returns null for keys over the max length', () => {
    const tooLong = 'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1);
    expect(normalizeIdempotencyKey(tooLong)).toBeNull();
  });

  it('accepts a key exactly at the max length', () => {
    const atLimit = 'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH);
    expect(normalizeIdempotencyKey(atLimit)).toBe(atLimit);
  });

  it('measures length after trimming', () => {
    // 250 real chars wrapped in whitespace stays under the limit once trimmed.
    const padded = `   ${'a'.repeat(250)}   `;
    expect(normalizeIdempotencyKey(padded)).toBe('a'.repeat(250));
  });
});
