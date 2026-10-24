import { describe, expect, it } from 'bun:test';
import { isGrantExpired, planGrantSweep } from './grant-ttl';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const at = (iso: string) => new Date(iso);

describe('personal grant TTL (the sweeper never revokes a grant with time left)', () => {
  it('no expiry never lapses; expiry is inclusive', () => {
    expect(isGrantExpired({ id: 'a', expiresAt: null }, NOW)).toBe(false);
    expect(isGrantExpired({ id: 'a', expiresAt: at('2026-10-24T12:00:00.000Z') }, NOW)).toBe(true);
    expect(isGrantExpired({ id: 'a', expiresAt: at('2026-10-24T12:00:00.001Z') }, NOW)).toBe(false);
    expect(isGrantExpired({ id: 'a', expiresAt: '2026-10-24T11:59:59.000Z' }, NOW)).toBe(true);
  });

  it('a malformed timestamp keeps the grant (never revoke on garbage)', () => {
    expect(isGrantExpired({ id: 'a', expiresAt: 'soon' }, NOW)).toBe(false);
    expect(planGrantSweep([{ id: 'a', expiresAt: 'soon' }], NOW)).toEqual({ expired: [], kept: 1, nextExpiry: null });
  });

  it('plans the expired ones oldest first, counts the rest, and names the next expiry', () => {
    const plan = planGrantSweep(
      [
        { id: 'g-later', expiresAt: at('2026-10-24T13:00:00.000Z') },
        { id: 'g-b', expiresAt: at('2026-10-24T11:00:00.000Z') },
        { id: 'g-forever', expiresAt: null },
        { id: 'g-a', expiresAt: at('2026-10-24T11:00:00.000Z') },
        { id: 'g-old', expiresAt: at('2026-10-20T09:00:00.000Z') },
        { id: 'g-soon', expiresAt: at('2026-10-24T12:05:00.000Z') },
      ],
      NOW,
    );
    expect(plan.expired.map((g) => g.id)).toEqual(['g-old', 'g-a', 'g-b']);
    expect(plan.kept).toBe(3);
    expect(plan.nextExpiry).toEqual(at('2026-10-24T12:05:00.000Z'));
  });

  it('nothing to do: an empty plan', () => {
    expect(planGrantSweep([], NOW)).toEqual({ expired: [], kept: 0, nextExpiry: null });
    expect(planGrantSweep([{ id: 'x', expiresAt: null }], NOW)).toEqual({ expired: [], kept: 1, nextExpiry: null });
  });

  it('keeps the caller row shape (the sweeper reads id + its own fields back)', () => {
    const rows = [{ id: 'g1', expiresAt: at('2026-10-24T10:00:00.000Z'), principalId: 'u1' }];
    expect(planGrantSweep(rows, NOW).expired[0]).toBe(rows[0]!);
  });
});
