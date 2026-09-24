import { describe, expect, it } from 'bun:test';
import { isCron, parseDuration, parseRate, parseSizeMb } from './units';

describe('units', () => {
  it('parses durations to seconds', () => {
    expect(parseDuration('90s')).toBe(90);
    expect(parseDuration('15m')).toBe(900);
    expect(parseDuration('48h')).toBe(172800);
    expect(parseDuration('7d')).toBe(604800);
    expect(parseDuration(30)).toBe(30);
    expect(parseDuration('15 minutes')).toBeNull();
    expect(parseDuration(-1)).toBeNull();
  });

  it('parses sizes to binary megabytes', () => {
    expect(parseSizeMb('512mb')).toBe(512);
    expect(parseSizeMb('1gb')).toBe(1024);
    expect(parseSizeMb('1.5GiB')).toBe(1536);
    expect(parseSizeMb(256)).toBe(256);
    expect(parseSizeMb('10kb')).toBeNull(); // under 1MB
    expect(parseSizeMb('lots')).toBeNull();
  });

  it('parses rates into the ingress RateLimitRule shape', () => {
    expect(parseRate('100/min')).toEqual({ requests: 100, windowSeconds: 60 });
    expect(parseRate('5 / s')).toEqual({ requests: 5, windowSeconds: 1 });
    expect(parseRate('0/min')).toBeNull();
    expect(parseRate('100 per minute')).toBeNull();
  });

  it('shape-checks five-field cron', () => {
    expect(isCron('0 2 * * *')).toBe(true);
    expect(isCron('*/5 * * * MON-FRI')).toBe(true);
    expect(isCron('0 2 * *')).toBe(false);
    expect(isCron('@daily')).toBe(false);
  });
});
