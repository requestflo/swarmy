import { describe, expect, test } from 'bun:test';
import { foldPullEvent, newPullAccumulator, type PullProgressEvent } from './docker';

const fold = (events: PullProgressEvent[]) => events.reduce(foldPullEvent, newPullAccumulator());

describe('foldPullEvent', () => {
  test('a clean pull records the digest and no error', () => {
    const acc = fold([
      { status: 'Pulling from library/nginx' },
      { status: 'Download complete' },
      { status: 'Digest: sha256:abc', aux: { Digest: 'sha256:abc' } },
    ]);
    expect(acc).toEqual({ digest: 'sha256:abc' });
  });

  test('a mid-pull errorDetail is captured with the real daemon message', () => {
    const acc = fold([
      { status: 'Downloading' },
      {
        errorDetail: { message: 'write /var/lib/docker/tmp/x: no space left on device' },
        error: 'write /var/lib/docker/tmp/x: no space left on device',
      },
    ]);
    expect(acc.error).toBe('write /var/lib/docker/tmp/x: no space left on device');
  });

  test('a bare {error} event (no errorDetail) is captured', () => {
    expect(fold([{ error: 'toomanyrequests: rate limit' }]).error).toBe('toomanyrequests: rate limit');
  });

  test('the first error wins', () => {
    expect(fold([{ error: 'first' }, { error: 'second' }]).error).toBe('first');
  });
});
