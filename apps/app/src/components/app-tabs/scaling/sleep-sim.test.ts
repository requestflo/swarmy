import { describe, expect, test } from 'bun:test';
import { foldSlots, idleDuration, idleWords, simulateSleep, sleptWords } from './sleep-sim';
import { otelServiceName, toCallBuckets, yesterdayWindow } from './series-model';
import { sleepDayWords, sleepNowWords } from './sleep-words';

const MIN = 60_000;
const B = 5 * MIN;
const from = Date.UTC(2026, 9, 22);
/** Busy buckets at these 5-minute indexes, 10 calls each. */
const busyAt = (...idx: number[]) => idx.map((i) => ({ t: from + i * B, calls: 10 }));

describe('simulateSleep', () => {
  test('sleeps once the idle window passes after the last busy bucket, wakes on the next', () => {
    // busy 0, idle 1..11 (55 min), busy 12; 15 min idle → asleep from 5 min + 15 = 20 min to 60 min
    const sim = simulateSleep({ from, to: from + 13 * B, bucketMs: B, buckets: busyAt(0, 12), idleMs: 15 * MIN });
    expect(sim.asleepMs).toBe(40 * MIN);
    expect(sim.naps).toBe(1);
    expect(sim.wakes).toBe(1);
    expect(sim.calls).toBe(20);
    expect(sim.slots[3]!.asleepMs).toBe(0); // 15–20 min: still inside the window
    expect(sim.slots[4]!.asleepMs).toBe(B);
    expect(sim.slots[12]!.asleepMs).toBe(0);
  });

  test('a gap shorter than the idle window never sleeps', () => {
    const sim = simulateSleep({ from, to: from + 6 * B, bucketMs: B, buckets: busyAt(0, 3, 5), idleMs: 15 * MIN });
    expect(sim.asleepMs).toBe(0);
    expect(sim.naps).toBe(0);
    expect(sim.wakes).toBe(0);
  });

  test('a partial bucket counts only the asleep part (idle not a bucket multiple)', () => {
    // busy 0; idle window 7 min → sleeps at 12 min, in the middle of bucket 2 (10–15)
    const sim = simulateSleep({ from, to: from + 3 * B, bucketMs: B, buckets: busyAt(0), idleMs: 7 * MIN });
    expect(sim.slots[2]!.asleepMs).toBe(3 * MIN);
    expect(sim.wakes).toBe(0); // the day ended asleep
  });

  test('the clock starts at the window start (no nap credited before data)', () => {
    const sim = simulateSleep({ from, to: from + 4 * B, bucketMs: B, buckets: [], idleMs: 15 * MIN });
    expect(sim.asleepMs).toBe(5 * MIN);
    expect(sim.calls).toBe(0);
  });

  test('two naps, buckets outside the window and misaligned starts', () => {
    const buckets = [...busyAt(0, 10, 20), { t: from - B, calls: 99 }, { t: from + 10 * B + 1_000, calls: 1 }];
    const sim = simulateSleep({ from, to: from + 21 * B, bucketMs: B, buckets, idleMs: 5 * MIN });
    expect(sim.naps).toBe(2);
    expect(sim.wakes).toBe(2);
    expect(sim.calls).toBe(31);
    expect(sim.asleepMs).toBe(2 * 8 * B);
  });
});

test('foldSlots adds calls and sleep per wider bar', () => {
  const sim = simulateSleep({ from, to: from + 13 * B, bucketMs: B, buckets: busyAt(0, 12), idleMs: 15 * MIN });
  const bars = foldSlots(sim.slots, 6);
  expect(bars.length).toBe(3);
  expect(bars[0]).toEqual({ t: from, calls: 10, asleepMs: 2 * B });
  expect(bars[1]!.asleepMs).toBe(6 * B);
  expect(bars[2]!.calls).toBe(10);
});

test('words for durations', () => {
  expect(sleptWords(40 * MIN)).toBe('40 min');
  expect(sleptWords(7.4 * 60 * MIN)).toBe('7.5 h');
  expect(idleWords(900)).toBe('15 min');
  expect(idleWords(3600)).toBe('1 h');
  expect(idleWords(45)).toBe('45 s');
  expect(idleDuration(900)).toBe('15m');
  expect(idleDuration(3600)).toBe('1h');
});

describe('sleep sentences', () => {
  const sim = simulateSleep({ from, to: from + 13 * B, bucketMs: B, buckets: busyAt(0, 12), idleMs: 15 * MIN });

  test('the day: slept, and who would have woken it', () => {
    expect(sleepDayWords({ name: 'web', sim, idleSec: 900, address: 'shop.northwind.dev' })).toBe(
      'With 15 min idle, web would have slept about 40 min yesterday, in one nap. A request would have had to wake it once.',
    );
    expect(sleepDayWords({ name: 'checkout', sim, idleSec: 900, address: null })).toContain('with no address to wake it');
  });

  test('no requests is not "slept all day"', () => {
    const empty = simulateSleep({ from, to: from + 4 * B, bucketMs: B, buckets: [], idleMs: 15 * MIN });
    expect(sleepDayWords({ name: 'web', sim: empty, idleSec: 900, address: null })).toContain('saw no requests');
  });

  test('never idle long enough', () => {
    const busy = simulateSleep({ from, to: from + 3 * B, bucketMs: B, buckets: busyAt(0, 1, 2), idleMs: 15 * MIN });
    expect(sleepDayWords({ name: 'web', sim: busy, idleSec: 900, address: null })).toBe("Never idle for 15 min yesterday, so it wouldn't have slept.");
  });

  test('now: wakes only through an address', () => {
    expect(sleepNowWords({ name: 'web', enabled: true, asleep: false, idleSec: 300, address: 'shop.northwind.dev' })).toBe(
      'Sleeps after 5 min with no requests. The next visit to shop.northwind.dev wakes it; that visit waits while a copy starts.',
    );
    expect(sleepNowWords({ name: 'checkout', enabled: true, asleep: true, idleSec: 300, address: null })).toBe(
      "Asleep now. Nothing outside reaches checkout, so a request can't wake it.",
    );
    expect(sleepNowWords({ name: 'web', enabled: false, asleep: false, idleSec: 300, address: 'a.b' })).toBe('Always on, even when nobody is visiting.');
  });
});

describe('series model', () => {
  test('yesterday is the previous local calendar day', () => {
    const now = new Date(2026, 9, 23, 9, 30).getTime();
    const w = yesterdayWindow(now);
    expect(w.from).toBe(new Date(2026, 9, 22).getTime());
    expect(w.to).toBe(new Date(2026, 9, 23).getTime());
    expect(w.windowMinutes).toBe(Math.ceil((now - w.from) / MIN) + 5);
  });

  test('spans carry the service’s own OTEL_SERVICE_NAME, else its name', () => {
    expect(otelServiceName({ name: 'storefront_web', env: ['A=1', 'OTEL_SERVICE_NAME=storefront-web'] })).toBe('storefront-web');
    expect(otelServiceName({ name: 'storefront_web', env: ['OTEL_SERVICE_NAME='] })).toBe('storefront_web');
  });

  test('ClickHouse bucket strings are UTC', () => {
    expect(toCallBuckets([{ bucket: '2026-10-22 10:05:00', calls: 3 }, { bucket: 'nope', calls: 1 }])).toEqual([
      { t: Date.UTC(2026, 9, 22, 10, 5), calls: 3 },
    ]);
  });
});
