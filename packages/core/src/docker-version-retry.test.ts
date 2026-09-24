import { describe, expect, test } from 'bun:test';
import { isVersionConflict, withVersionRetry } from './docker';

const noSleep = { sleep: async () => undefined };

describe('isVersionConflict', () => {
  test('matches swarm optimistic-concurrency failures only', () => {
    expect(isVersionConflict(new Error('rpc error: code = Unknown desc = update out of sequence'))).toBe(true);
    expect(isVersionConflict('update out of sequence')).toBe(true);
    expect(isVersionConflict(new Error('no such service: web'))).toBe(false);
    expect(isVersionConflict(undefined)).toBe(false);
  });
});

describe('withVersionRetry', () => {
  test('retries conflicts, passing the attempt number, then succeeds', async () => {
    const attempts: number[] = [];
    const r = await withVersionRetry(async (n) => {
      attempts.push(n);
      if (n < 3) throw new Error('update out of sequence');
      return 'ok';
    }, noSleep);
    expect(r).toBe('ok');
    expect(attempts).toEqual([1, 2, 3]);
  });

  test('bounded: rethrows the last conflict', async () => {
    let n = 0;
    await expect(
      withVersionRetry(async () => {
        n++;
        throw new Error('update out of sequence');
      }, { ...noSleep, attempts: 4 }),
    ).rejects.toThrow('out of sequence');
    expect(n).toBe(4);
  });

  test('other errors are not retried', async () => {
    let n = 0;
    await expect(
      withVersionRetry(async () => {
        n++;
        throw new Error('boom');
      }, noSleep),
    ).rejects.toThrow('boom');
    expect(n).toBe(1);
  });
});
