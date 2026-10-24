import { describe, expect, it } from 'bun:test';
import { digestOf, rolloutProgress, type LiveServiceLike } from './build-rollout';

const DIGEST = `sha256:${'4e1c09a7'.repeat(8)}`;
const IMAGE = `localhost:5000/northwind-storefront@${DIGEST}`;
const svc = (over: Partial<LiveServiceLike> = {}): LiveServiceLike => ({
  name: 'storefront_checkout',
  image: IMAGE,
  desiredReplicas: 3,
  runningReplicas: 3,
  updateStatus: 'completed',
  labels: { 'com.docker.stack.namespace': 'storefront' },
  ...over,
});

describe('digestOf', () => {
  it('reads the digest of a pinned image only', () => {
    expect(digestOf(IMAGE)).toBe(DIGEST);
    expect(digestOf('localhost:5000/app:main')).toBeNull();
  });
});

describe('rolloutProgress', () => {
  it('waits until a service of the stack runs the digest', () => {
    expect(rolloutProgress([svc({ image: 'localhost:5000/northwind-storefront@sha256:old' })], DIGEST, 'storefront')).toEqual({ state: 'waiting' });
    // Same digest in another stack (a preview) is not this rollout.
    expect(rolloutProgress([svc({ labels: { 'com.docker.stack.namespace': 'storefront-pr-7' } })], DIGEST, 'storefront')).toEqual({ state: 'waiting' });
  });

  it('is done when every copy runs, and says drained only when Docker completed an update', () => {
    expect(rolloutProgress([svc()], DIGEST, 'storefront')).toEqual({
      state: 'done',
      facts: { stack: 'storefront', services: ['checkout'], ready: 3, desired: 3, drained: true },
    });
    // A first deploy: no previous copy, so no "drained" claim.
    const first = rolloutProgress([svc({ updateStatus: undefined })], DIGEST, 'storefront');
    expect(first).toEqual({ state: 'done', facts: { stack: 'storefront', services: ['checkout'], ready: 3, desired: 3 } });
  });

  it('is rolling while Docker updates or copies are still starting', () => {
    expect(rolloutProgress([svc({ runningReplicas: 2, updateStatus: 'updating' })], DIGEST, 'storefront')).toMatchObject({
      state: 'rolling',
      facts: { ready: 2, desired: 3 },
    });
    expect(rolloutProgress([svc({ runningReplicas: 1, updateStatus: undefined })], DIGEST, 'storefront').state).toBe('rolling');
  });

  it('fails when Docker rolls back or pauses the update', () => {
    const back = rolloutProgress([svc({ updateStatus: 'rollback_completed' })], DIGEST, 'storefront');
    expect(back).toMatchObject({ state: 'failed', error: 'Docker put the previous copy back' });
    expect(rolloutProgress([svc({ updateStatus: 'paused', runningReplicas: 2 })], DIGEST, 'storefront').state).toBe('failed');
  });

  it('sums every service running the digest', () => {
    const p = rolloutProgress(
      [svc(), svc({ name: 'storefront_worker', desiredReplicas: 1, runningReplicas: 0, updateStatus: 'updating' })],
      DIGEST,
      'storefront',
    );
    expect(p).toMatchObject({ state: 'rolling', facts: { services: ['checkout', 'worker'], ready: 3, desired: 4 } });
  });
});
