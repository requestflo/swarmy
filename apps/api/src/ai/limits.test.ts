import { describe, expect, it } from 'bun:test';
import { AuthFailureLimiter, DEFAULT_KEY_RPM, defaultKeyRpm, effectiveRpm, RpmWindow } from './limits';

describe('default RPM per virtual key', () => {
  it('applies to keys without their own limit; SWARMY_AI_DEFAULT_RPM tunes or disables it', () => {
    expect(DEFAULT_KEY_RPM).toBe(600);
    expect(defaultKeyRpm({})).toBe(600);
    expect(defaultKeyRpm({ SWARMY_AI_DEFAULT_RPM: '120' })).toBe(120);
    expect(defaultKeyRpm({ SWARMY_AI_DEFAULT_RPM: '0' })).toBeNull();
    expect(defaultKeyRpm({ SWARMY_AI_DEFAULT_RPM: 'off' })).toBeNull();
    expect(defaultKeyRpm({ SWARMY_AI_DEFAULT_RPM: 'lots' })).toBe(600);
    expect(effectiveRpm(null, {})).toBe(600);
    // A key's own limit wins, above or below the default.
    expect(effectiveRpm(5000, {})).toBe(5000);
    expect(effectiveRpm(10, { SWARMY_AI_DEFAULT_RPM: 'off' })).toBe(10);
  });
});

describe('AuthFailureLimiter (per-IP 401s)', () => {
  it('blocks an address after the failures in a minute, then lets it try again', () => {
    const l = new AuthFailureLimiter(3);
    for (let i = 0; i < 3; i++) {
      expect(l.blocked('10.0.0.9', i)).toBe(false);
      l.fail('10.0.0.9', i);
    }
    expect(l.blocked('10.0.0.9', 10)).toBe(true);
    expect(l.blocked('10.0.0.10', 10)).toBe(false);
    expect(l.blocked('10.0.0.9', 60_003)).toBe(false);
  });

  it('never limits a request with no known address (in-process playground)', () => {
    const l = new AuthFailureLimiter(1);
    l.fail(null, 0);
    l.fail(null, 1);
    expect(l.blocked(null, 2)).toBe(false);
  });
});

describe('RpmWindow.count', () => {
  it('reads the window without recording a hit', () => {
    const w = new RpmWindow();
    w.allow('k', 5, 0);
    expect(w.count('k', 1)).toBe(1);
    expect(w.count('k', 2)).toBe(1);
    expect(w.count('k', 60_000)).toBe(0);
  });
});
