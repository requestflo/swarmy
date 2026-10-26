import { describe, expect, it } from 'bun:test';
import { previewSleepState } from './preview-sleep';

const svc = (stack: string, desired: number, running: number, scaleToZero = true) => ({
  labels: { 'swarmy.app.stack': stack },
  scaleToZero,
  replicas: { desired, running },
});

describe('previewSleepState: is a preview asleep right now', () => {
  it('asleep once every service that sleeps is at 0 by design', () => {
    expect(previewSleepState([svc('shop-pr7', 0, 0), svc('shop-pr7', 1, 1, false)], 'shop-pr7')).toBe('asleep');
  });

  it('awake while any of them runs (or is waking up)', () => {
    expect(previewSleepState([svc('shop-pr7', 0, 0), svc('shop-pr7', 1, 0)], 'shop-pr7')).toBe('awake');
  });

  it('nothing to say for a preview that never sleeps, or one that is gone', () => {
    expect(previewSleepState([svc('shop-pr7', 1, 1, false)], 'shop-pr7')).toBeNull();
    expect(previewSleepState([svc('shop-pr8', 0, 0)], 'shop-pr7')).toBeNull();
  });
});
