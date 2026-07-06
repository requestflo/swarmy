import { describe, expect, it } from 'bun:test';
import { RouteProtectionSchema } from './types';

describe('RouteProtectionSchema — cache / country / waf field validation', () => {
  it('parses a minimal protection and defaults the new fields', () => {
    const p = RouteProtectionSchema.parse({});
    expect(p.cache).toBeUndefined();
    // Optional, NOT defaulted: pre-existing compacted label shapes must
    // round-trip byte-identically, so absence stays absence.
    expect(p.countryAllow).toBeUndefined();
    expect(p.countryDeny).toBeUndefined();
    expect(p.waf).toBeUndefined();
  });

  it('cache: ttl bounds are 1..86400 seconds', () => {
    expect(RouteProtectionSchema.safeParse({ cache: { ttlSeconds: 1 } }).success).toBe(true);
    expect(RouteProtectionSchema.safeParse({ cache: { ttlSeconds: 86400 } }).success).toBe(true);
    expect(RouteProtectionSchema.safeParse({ cache: { ttlSeconds: 0 } }).success).toBe(false);
    expect(RouteProtectionSchema.safeParse({ cache: { ttlSeconds: 86401 } }).success).toBe(false);
    expect(RouteProtectionSchema.safeParse({ cache: { ttlSeconds: 30.5 } }).success).toBe(false);
  });

  it('cache: keyHeaders must be non-empty strings', () => {
    expect(
      RouteProtectionSchema.safeParse({ cache: { ttlSeconds: 60, keyHeaders: ['Accept'] } }).success,
    ).toBe(true);
    expect(
      RouteProtectionSchema.safeParse({ cache: { ttlSeconds: 60, keyHeaders: [''] } }).success,
    ).toBe(false);
  });

  it('country codes must be ISO 3166-1 alpha-2 UPPERCASE', () => {
    expect(RouteProtectionSchema.safeParse({ countryAllow: ['GB', 'IE'] }).success).toBe(true);
    expect(RouteProtectionSchema.safeParse({ countryDeny: ['RU'] }).success).toBe(true);
    expect(RouteProtectionSchema.safeParse({ countryAllow: ['gb'] }).success).toBe(false);
    expect(RouteProtectionSchema.safeParse({ countryAllow: ['GBR'] }).success).toBe(false);
    expect(RouteProtectionSchema.safeParse({ countryAllow: ['G1'] }).success).toBe(false);
    expect(RouteProtectionSchema.safeParse({ countryDeny: [''] }).success).toBe(false);
  });

  it('waf: {} defaults blockScannerPaths true, empty methods/patterns', () => {
    const p = RouteProtectionSchema.parse({ waf: {} });
    expect(p.waf?.blockScannerPaths).toBe(true);
    expect(p.waf?.blockMethods).toEqual([]);
    expect(p.waf?.denyQueryPatterns).toEqual([]);
  });

  it('waf: blockMethods must be uppercase HTTP method tokens', () => {
    expect(RouteProtectionSchema.safeParse({ waf: { blockMethods: ['TRACE', 'DELETE'] } }).success).toBe(true);
    expect(RouteProtectionSchema.safeParse({ waf: { blockMethods: ['trace'] } }).success).toBe(false);
    expect(RouteProtectionSchema.safeParse({ waf: { blockMethods: ['GET POST'] } }).success).toBe(false);
  });

  it('waf: denyQueryPatterns must compile as regex', () => {
    expect(
      RouteProtectionSchema.safeParse({ waf: { denyQueryPatterns: ['(?i)union.*select'] } }).success,
    ).toBe(true);
    expect(RouteProtectionSchema.safeParse({ waf: { denyQueryPatterns: ['[unclosed'] } }).success).toBe(
      false,
    );
  });

  it('waf: denyQueryPatterns reject backticks/double-quotes (CEL token safety)', () => {
    expect(RouteProtectionSchema.safeParse({ waf: { denyQueryPatterns: ['a`b'] } }).success).toBe(false);
    expect(RouteProtectionSchema.safeParse({ waf: { denyQueryPatterns: ['a"b'] } }).success).toBe(false);
  });
});
