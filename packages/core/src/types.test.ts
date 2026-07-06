import { describe, expect, it } from 'bun:test';
import { EXPOSE_LABEL, EXPOSE_MODES, parseExposeMode } from './types';

describe('parseExposeMode — the `swarmy.expose` label codec', () => {
  it('accepts every declared mode verbatim', () => {
    for (const mode of EXPOSE_MODES) {
      expect(parseExposeMode(mode)).toBe(mode);
    }
  });

  it('absent / unknown / junk values → null (undeclared)', () => {
    expect(parseExposeMode(undefined)).toBeNull();
    expect(parseExposeMode(null)).toBeNull();
    expect(parseExposeMode('')).toBeNull();
    expect(parseExposeMode('Public')).toBeNull();
    expect(parseExposeMode('internal')).toBeNull();
  });

  it('label constant is the documented service label', () => {
    expect(EXPOSE_LABEL).toBe('swarmy.expose');
  });
});
