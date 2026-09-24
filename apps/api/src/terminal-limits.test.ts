import { describe, expect, it } from 'bun:test';
import { terminalLimitExpired } from './terminal-limits';

const MIN = 60_000;
const base = { startedAt: 0, lastInputAt: 0, idleTimeoutMs: 5 * MIN, maxSessionMs: 60 * MIN };

describe('terminalLimitExpired — controller-enforced idle + max session', () => {
  it('keeps an active session inside both limits', () => {
    expect(terminalLimitExpired({ ...base, lastInputAt: 58 * MIN, now: 59 * MIN })).toBeNull();
  });

  it('closes after idleTimeoutMs without input', () => {
    expect(terminalLimitExpired({ ...base, lastInputAt: 10 * MIN, now: 15 * MIN })).toBe('idle_timeout');
    expect(terminalLimitExpired({ ...base, lastInputAt: 10 * MIN, now: 15 * MIN - 1 })).toBeNull();
  });

  it('closes at maxSessionMs even while the user is typing', () => {
    expect(terminalLimitExpired({ ...base, lastInputAt: 60 * MIN, now: 60 * MIN })).toBe('max_session');
  });

  it('max session wins when both are due', () => {
    expect(terminalLimitExpired({ ...base, lastInputAt: 0, now: 61 * MIN })).toBe('max_session');
  });

  it('treats a zero limit as off', () => {
    expect(terminalLimitExpired({ ...base, idleTimeoutMs: 0, maxSessionMs: 0, now: 999 * MIN })).toBeNull();
  });
});
