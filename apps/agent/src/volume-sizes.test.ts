import { describe, expect, it } from 'bun:test';
import type { VolumeSizeEntry } from '@swarmy/core/protocol';
import { createVolumeSizer } from './volume-sizes';

/** A measurement the test resolves by hand, so in-flight and cadence are visible. */
function fakeMeasure() {
  const calls: { resolve: (v: VolumeSizeEntry[]) => void; reject: (e: Error) => void }[] = [];
  const measure = () =>
    new Promise<VolumeSizeEntry[]>((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  return { measure, calls };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('volume sizer — slow cadence, cached, sent once per measurement', () => {
  it('the first tick starts a measurement without waiting; the result goes out on the next tick, once', async () => {
    let t = 1_000;
    const { measure, calls } = fakeMeasure();
    const sizer = createVolumeSizer(measure, { intervalMs: 600_000, now: () => t });
    expect(sizer.take()).toBeUndefined();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve([{ name: 'shop_pg', sizeBytes: 42 }]);
    await settle();
    t += 5_000;
    expect(sizer.take()).toEqual({ sampledAt: 1_000, volumes: [{ name: 'shop_pg', sizeBytes: 42 }] });
    expect(sizer.take()).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('never measures twice at once, and re-measures only after the interval', async () => {
    let t = 0;
    const { measure, calls } = fakeMeasure();
    const sizer = createVolumeSizer(measure, { intervalMs: 600_000, now: () => t });
    sizer.take();
    t = 700_000; // a slow df: the interval passed while it ran
    sizer.take();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve([]);
    await settle();
    t = 700_001;
    sizer.take(); // started at 0, done: due again
    expect(calls).toHaveLength(2);
    calls[1]!.resolve([]);
    await settle();
    t = 800_000;
    sizer.take();
    expect(calls).toHaveLength(2);
  });

  it('resend() puts the cached sample on the next frame (a new session); nothing to resend before the first one', async () => {
    const t = 0;
    const { measure, calls } = fakeMeasure();
    const sizer = createVolumeSizer(measure, { intervalMs: 600_000, now: () => t });
    sizer.resend();
    expect(sizer.take()).toBeUndefined();
    calls[0]!.resolve([{ name: 'a', sizeBytes: 1 }]);
    await settle();
    expect(sizer.take()?.volumes).toHaveLength(1);
    expect(sizer.take()).toBeUndefined();
    sizer.resend();
    expect(sizer.take()?.volumes).toEqual([{ name: 'a', sizeBytes: 1 }]);
  });

  it('a failed measurement keeps the last good sample unsent-again, logs once, and retries next interval', async () => {
    let t = 0;
    const logs: string[] = [];
    const { measure, calls } = fakeMeasure();
    const sizer = createVolumeSizer(measure, { intervalMs: 600_000, now: () => t, log: (m) => logs.push(m) });
    sizer.take();
    calls[0]!.resolve([{ name: 'a', sizeBytes: 1 }]);
    await settle();
    expect(sizer.take()).toBeDefined();
    t = 600_000;
    sizer.take();
    calls[1]!.reject(new Error('df timed out'));
    await settle();
    expect(sizer.take()).toBeUndefined();
    t = 1_200_000;
    sizer.take();
    calls[2]!.reject(new Error('df timed out'));
    await settle();
    expect(logs).toEqual(['could not measure volume sizes: df timed out']);
    sizer.resend();
    expect(sizer.take()?.volumes).toEqual([{ name: 'a', sizeBytes: 1 }]);
  });
});
