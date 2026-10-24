import { describe, expect, it } from 'bun:test';
import { verifyWakeToken, WAKE_TOKEN_LENGTH, wakePathFor, wakeToken } from './wake-token';

const KEY = 'k'.repeat(64);

describe('signed wake tokens', () => {
  it('are short, url-safe and stable for one org + service + key', () => {
    const t = wakeToken('org_a', 'web', KEY);
    expect(t).toHaveLength(WAKE_TOKEN_LENGTH);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(wakeToken('org_a', 'web', KEY)).toBe(t);
  });

  it('bind the org, the service and the key', () => {
    const t = wakeToken('org_a', 'web', KEY);
    expect(wakeToken('org_b', 'web', KEY)).not.toBe(t);
    expect(wakeToken('org_a', 'api', KEY)).not.toBe(t);
    expect(wakeToken('org_a', 'web', 'x'.repeat(64))).not.toBe(t);
    // No field-boundary games: `org_a\nweb` is not `org_\na web`.
    expect(wakeToken('org_', 'aweb', KEY)).not.toBe(t);
  });

  it('verify only the exact token, in constant time', () => {
    const t = wakeToken('org_a', 'web', KEY);
    expect(verifyWakeToken('org_a', 'web', t, KEY)).toBe(true);
    expect(verifyWakeToken('org_b', 'web', t, KEY)).toBe(false);
    expect(verifyWakeToken('org_a', 'web', `${t.slice(0, -1)}${t.endsWith('A') ? 'B' : 'A'}`, KEY)).toBe(false);
    expect(verifyWakeToken('org_a', 'web', t.slice(0, 10), KEY)).toBe(false);
    expect(verifyWakeToken('org_a', 'web', '', KEY)).toBe(false);
  });

  it('render as the activator path the edge rewrites to', () => {
    expect(wakePathFor('org_a', 'web', KEY)).toBe(`/_wake/web/${wakeToken('org_a', 'web', KEY)}`);
  });

  it('still sign and verify within one process when no key is configured (dev)', () => {
    const t = wakeToken('org_a', 'web', undefined);
    expect(t).toHaveLength(WAKE_TOKEN_LENGTH);
    expect(verifyWakeToken('org_a', 'web', t, undefined)).toBe(true);
    expect(verifyWakeToken('org_a', 'web', t, KEY)).toBe(false);
  });
});
