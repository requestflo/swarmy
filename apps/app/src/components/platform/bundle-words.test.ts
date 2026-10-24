import { describe, expect, it } from 'bun:test';
import { bundlePercent, bundleWords, sizeWords } from './bundle-words';

const base = { size: 3_400_000_000, received: 1_200_000_000 };

describe('bundleWords', () => {
  it('says how much has been sent, then how many images are in', () => {
    expect(bundleWords({ ...base, phase: 'sending' })).toBe('Sending the bundle: 1.2 GB of 3.4 GB');
    expect(bundleWords({ ...base, phase: 'loading' })).toBe('Checking the signature…');
    expect(bundleWords({ ...base, phase: 'loading', version: '1.3.0', total: 28, done: 5, current: 'garage' })).toBe(
      'Copying swarmy 1.3.0 into your cluster: 5 of 28 images (garage)',
    );
    expect(bundleWords({ ...base, phase: 'done', version: '1.3.0' })).toBe('swarmy 1.3.0 is verified and in your cluster. Upgrade is ready above.');
  });

  it('a failure says nothing was upgraded, and why', () => {
    expect(bundleWords({ ...base, phase: 'failed', error: 'unverified release: the signature does not match the swarmy release key — nothing was loaded' })).toBe(
      'Nothing was upgraded: unverified release: the signature does not match the swarmy release key — nothing was loaded',
    );
  });
});

describe('bundlePercent / sizeWords', () => {
  it('sending fills the first half, loading the second', () => {
    expect(bundlePercent({ ...base, phase: 'sending', received: 1_700_000_000 })).toBe(25);
    expect(bundlePercent({ ...base, phase: 'loading', total: 10, done: 5 })).toBe(75);
    expect(bundlePercent({ ...base, phase: 'done' })).toBe(100);
  });
  it('sizes', () => {
    expect(sizeWords(340_000_000)).toBe('340 MB');
    expect(sizeWords(12_000)).toBe('12 KB');
  });
});
