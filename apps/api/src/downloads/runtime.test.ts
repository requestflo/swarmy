import { describe, expect, it } from 'bun:test';
import { maxLiveDownloads, runtimeHoldsResponseBackpressure } from './runtime';

describe('runtime response backpressure (measured on 1.3.14 vs 1.4.4)', () => {
  it('1.3.x buffers; 1.4+ holds', () => {
    expect(runtimeHoldsResponseBackpressure('1.3.14')).toBe(false);
    expect(runtimeHoldsResponseBackpressure('1.4.4')).toBe(true);
    expect(runtimeHoldsResponseBackpressure('2.0.0')).toBe(true);
  });

  it('streams fewer downloads at once where the runtime buffers them', () => {
    expect(maxLiveDownloads('1.3.14')).toBe(2);
    expect(maxLiveDownloads('1.4.4')).toBe(8);
  });
});
