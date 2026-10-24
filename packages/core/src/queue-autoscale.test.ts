import { describe, expect, it } from 'bun:test';
import {
  CALM_MAX_GAP_MS,
  autoscaleStep,
  cooldownWords,
  desiredWorkers,
  encodeQueueCalmLabel,
  parseQueueCalmLabel,
  scaleDownWords,
  scalePushDue,
  type AutoscaleInput,
} from './queue-autoscale';

const T0 = Date.parse('2026-10-24T10:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const tick = (over: Partial<AutoscaleInput>): AutoscaleInput => ({
  current: 4,
  target: 4,
  cooldownSeconds: 600,
  calm: null,
  lastSampleAt: T0 - 15_000,
  now: T0,
  ...over,
});

describe('autoscaleStep — up now, down after the cooldown', () => {
  it('scales up the moment depth crosses the threshold, and clears any calm', () => {
    const s = autoscaleStep(tick({ current: 1, target: 3, calm: { since: iso(T0 - 9 * MIN), peak: 0 } }));
    expect(s).toEqual({ move: 'up', replicas: 3, calm: null, downAt: null });
  });

  it('holds steady when the depth asks for what runs', () => {
    expect(autoscaleStep(tick({}))).toEqual({ move: 'steady', replicas: 4, calm: null, downAt: null });
  });

  it('starts the calm clock instead of dropping copies', () => {
    const s = autoscaleStep(tick({ target: 1 }));
    expect(s).toEqual({ move: 'calming', replicas: 4, calm: { since: iso(T0), peak: 1 }, downAt: T0 + 10 * MIN });
  });

  it('drops after 10 min calm, to the most the window asked for', () => {
    const calm = { since: iso(T0 - 10 * MIN), peak: 2 };
    expect(autoscaleStep(tick({ target: 1, calm }))).toEqual({
      move: 'down',
      replicas: 2,
      calm: { since: iso(T0), peak: 1 },
      downAt: null,
    });
    expect(autoscaleStep(tick({ target: 2, calm })).calm).toBeNull();
  });

  it('keeps the clock and raises the peak while still calming', () => {
    const s = autoscaleStep(tick({ target: 3, calm: { since: iso(T0 - 4 * MIN), peak: 1 } }));
    expect(s).toEqual({ move: 'calming', replicas: 4, calm: { since: iso(T0 - 4 * MIN), peak: 3 }, downAt: T0 + 6 * MIN });
  });

  it('a burst inside the window resets it: no flapping', () => {
    let calm = autoscaleStep(tick({ target: 1, now: T0 })).calm;
    const burst = autoscaleStep(tick({ target: 4, calm, now: T0 + 8 * MIN, lastSampleAt: T0 + 8 * MIN - 15_000 }));
    expect(burst.move).toBe('steady');
    calm = burst.calm;
    const after = autoscaleStep(tick({ target: 1, calm, now: T0 + 12 * MIN, lastSampleAt: T0 + 12 * MIN - 15_000 }));
    expect(after).toMatchObject({ move: 'calming', replicas: 4, calm: { since: iso(T0 + 12 * MIN), peak: 1 } });
  });

  it('a clock read back off the label after a restart still counts', () => {
    const calm = parseQueueCalmLabel(encodeQueueCalmLabel({ since: iso(T0 - 11 * MIN), peak: 1 }));
    expect(autoscaleStep(tick({ target: 1, calm, lastSampleAt: T0 - 2 * MIN })).move).toBe('down');
  });

  it('minutes nobody measured are not calm: a long gap restarts the clock', () => {
    const calm = { since: iso(T0 - 30 * MIN), peak: 1 };
    const s = autoscaleStep(tick({ target: 1, calm, lastSampleAt: T0 - CALM_MAX_GAP_MS - 1 }));
    expect(s).toMatchObject({ move: 'calming', calm: { since: iso(T0), peak: 1 } });
    expect(autoscaleStep(tick({ target: 1, calm, lastSampleAt: null })).move).toBe('calming');
  });

  it('a clock whose peak no longer fits (someone scaled down by hand) restarts', () => {
    const s = autoscaleStep(tick({ current: 2, target: 1, calm: { since: iso(T0 - 20 * MIN), peak: 3 } }));
    expect(s).toMatchObject({ move: 'calming', calm: { since: iso(T0), peak: 1 } });
  });

  it('cooldown 0 drops straight away', () => {
    expect(autoscaleStep(tick({ target: 1, cooldownSeconds: 0 }))).toMatchObject({ move: 'down', replicas: 1, calm: null });
  });
});

describe('desiredWorkers', () => {
  it('clamps ceil(wait / scalePerJobs) between min and max', () => {
    const def = { scalePerJobs: 25, minWorkers: 1, maxWorkers: 4 };
    expect([0, 1, 26, 100, 10_000].map((w) => desiredWorkers(def, w))).toEqual([1, 1, 2, 4, 4]);
  });
});

describe('calm label codec', () => {
  it('round-trips and rejects foreign shapes', () => {
    const c = { since: iso(T0), peak: 2 };
    expect(parseQueueCalmLabel(encodeQueueCalmLabel(c))).toEqual(c);
    for (const raw of [undefined, '', 'nope', '[]', '{"since":"x","peak":1}', `{"since":"${iso(T0)}","peak":-1}`]) {
      expect(parseQueueCalmLabel(raw)).toBeNull();
    }
  });
});

describe('scalePushDue — the signature gate', () => {
  it('sends nothing at steady state and nothing twice while the inventory catches up', () => {
    expect(scalePushDue(4, 4, undefined, T0)).toBe(false);
    expect(scalePushDue(4, 2, undefined, T0)).toBe(true);
    expect(scalePushDue(4, 2, { replicas: 2, at: T0 - 15_000 }, T0)).toBe(false);
    expect(scalePushDue(4, 2, { replicas: 2, at: T0 - 61_000 }, T0)).toBe(true);
    expect(scalePushDue(4, 3, { replicas: 2, at: T0 - 15_000 }, T0)).toBe(true);
  });
});

describe('rule words', () => {
  it('says the cooldown the way the board does', () => {
    expect(scaleDownWords(1, 600)).toBe('back to 1 after 10 min calm');
    expect(scaleDownWords(0, 0)).toBe("back to 0 as soon as it's calm");
    expect([45, 90, 3600, 5400].map(cooldownWords)).toEqual(['45 s', '2 min', '1 h', '1 h 30 min']);
  });
});
