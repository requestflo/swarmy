import { describe, expect, it } from 'bun:test';
import { FENCE_WINDOW, fenceBoundMs, judgeFenceDrill, logLineAt, parseDockerTime, type FenceDrillObservation } from './fence-drill';
import { LEASE_FENCE_MARGIN_MS, LEASE_RENEW_EVERY_MS, LEASE_TTL_MS } from './lease';

const P = Date.parse('2026-10-24T12:00:00.000Z');
const good: FenceDrillObservation = {
  partitionAt: P,
  fencedAt: P + 47_000,
  exitCode: 70,
  takeoverAt: P + 47_000 + 20_000,
  oldEpoch: 4,
  newEpoch: 5,
};

describe('partition drill verdict (P3 "self-fences")', () => {
  it('uses the lease constants the controller runs with', () => {
    expect(FENCE_WINDOW.ttlMs).toBe(LEASE_TTL_MS);
    expect(FENCE_WINDOW.renewEveryMs).toBe(LEASE_RENEW_EVERY_MS);
    expect(FENCE_WINDOW.marginMs).toBe(LEASE_FENCE_MARGIN_MS);
    // TTL − margin + watchdog tick + 3 s skew.
    expect(fenceBoundMs()).toBe(56_000);
  });

  it('a fence inside the window, then a later takeover at a higher epoch, passes', () => {
    const v = judgeFenceDrill(good);
    expect(v).toMatchObject({ ok: true, problems: [], fencedAfterMs: 47_000, handoverGapMs: 20_000, meetsEpicTarget: false });
    expect(judgeFenceDrill({ ...good, fencedAt: P + 25_000, takeoverAt: P + 90_000 }).meetsEpicTarget).toBe(true);
  });

  it('a fence that never came, or came late, or exited the wrong way fails', () => {
    expect(judgeFenceDrill({ ...good, fencedAt: null, exitCode: null, takeoverAt: null }).problems).toEqual([
      'the old controller never logged FENCED',
      'the old controller exited never, not 70 (fenced)',
      'no new controller took the lease on the majority side',
    ]);
    expect(judgeFenceDrill({ ...good, fencedAt: P + 70_000, takeoverAt: P + 100_000 }).problems[0]).toBe(
      'fenced 70s after the partition; the design bound is 56s',
    );
    expect(judgeFenceDrill({ ...good, exitCode: 0 }).ok).toBe(false);
  });

  it('a takeover before the old holder fenced (two writers) fails, as does a stuck epoch', () => {
    expect(judgeFenceDrill({ ...good, takeoverAt: good.fencedAt! + 1_000 }).problems[0]).toContain('two writers?');
    expect(judgeFenceDrill({ ...good, newEpoch: 4 }).problems[0]).toContain('4 → 4');
  });
});

describe('logLineAt', () => {
  const logs = [
    '2026-10-24T12:00:01.123456789Z controller store: lease acquired (epoch 4)',
    'garbage',
    '2026-10-24T12:00:48.000000001Z controller store: FENCED: no successful renewal for 52s. Stopping writes and exiting.',
  ].join('\n');
  it('finds the first matching line and its docker timestamp (nanoseconds trimmed)', () => {
    expect(logLineAt(logs, /lease acquired \(epoch (\d+)\)/)).toEqual({ at: P + 1_123, line: 'controller store: lease acquired (epoch 4)' });
    expect(logLineAt(logs, /FENCED/)?.at).toBe(P + 48_000);
    expect(logLineAt(logs, /nope/)).toBeNull();
  });
  it('reads `docker info` SystemTime with an offset', () => {
    expect(parseDockerTime('2026-10-24T13:00:00.250000000+01:00\n')).toBe(P + 250);
    expect(parseDockerTime('garbage')).toBeNaN();
  });
});
