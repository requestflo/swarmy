import { describe, expect, it } from 'bun:test';
import {
  depthCommand,
  desiredWorkers,
  dlqListCommand,
  dlqRequeueCommand,
  drainCommand,
  encodeQueueStatsLabel,
  encodeQueuesLabel,
  parseCacheClusterRef,
  parseDepthOutput,
  parseQueueStatsLabel,
  parseQueuesLabel,
  parseRedisIntegers,
  parseRedisStrings,
  queueKeys,
  retryFailedCommand,
  shQuote,
} from './queues.service';
import type { QueueDef } from '@swarmy/core';

const BULL: QueueDef = {
  name: 'emails',
  cacheCluster: 'main',
  convention: 'bullmq',
  scalePerJobs: 25,
  minWorkers: 1,
  maxWorkers: 5,
  retries: 3,
  dlq: true,
};

const LIST: QueueDef = {
  ...BULL,
  name: 'outbox',
  convention: 'list',
  listKey: 'outbox:webhooks',
};

describe('queueKeys — redis key builders', () => {
  it('builds BullMQ key conventions', () => {
    expect(queueKeys(BULL)).toEqual({
      wait: 'bull:emails:wait',
      active: 'bull:emails:active',
      failed: 'bull:emails:failed',
      delayed: 'bull:emails:delayed',
      dead: 'emails:dead',
    });
  });

  it('raw list uses listKey with a :dead sibling and no bull keys', () => {
    expect(queueKeys(LIST)).toEqual({
      wait: 'outbox:webhooks',
      active: null,
      failed: null,
      delayed: null,
      dead: 'outbox:webhooks:dead',
    });
  });

  it('raw list defaults listKey to the queue name', () => {
    expect(queueKeys({ name: 'jobs', convention: 'list' }).wait).toBe('jobs');
    expect(queueKeys({ name: 'jobs', convention: 'list' }).dead).toBe('jobs:dead');
  });
});

describe('desiredWorkers — scale decision', () => {
  it('clamps ceil(wait/scalePerJobs) between min and max', () => {
    expect(desiredWorkers(BULL, 0)).toBe(1); // floor at minWorkers
    expect(desiredWorkers(BULL, 1)).toBe(1);
    expect(desiredWorkers(BULL, 26)).toBe(2);
    expect(desiredWorkers(BULL, 100)).toBe(4);
    expect(desiredWorkers(BULL, 10_000)).toBe(5); // ceiling at maxWorkers
  });

  it('allows scale-to-zero when minWorkers is 0', () => {
    const def = { scalePerJobs: 10, minWorkers: 0, maxWorkers: 3 };
    expect(desiredWorkers(def, 0)).toBe(0);
    expect(desiredWorkers(def, 1)).toBe(1);
  });

  it('never divides by zero and never returns below min or above max', () => {
    expect(desiredWorkers({ scalePerJobs: 0, minWorkers: 1, maxWorkers: 2 }, 100)).toBe(2);
    expect(desiredWorkers({ scalePerJobs: 10, minWorkers: 4, maxWorkers: 2 }, 0)).toBe(4);
    expect(desiredWorkers(BULL, -5)).toBe(1);
  });
});

describe('queues label codec', () => {
  it('round-trips defs through the label', () => {
    const raw = encodeQueuesLabel([BULL, LIST]);
    expect(parseQueuesLabel(raw)).toEqual([BULL, LIST]);
  });

  it('degrades malformed JSON and foreign shapes to []', () => {
    expect(parseQueuesLabel(undefined)).toEqual([]);
    expect(parseQueuesLabel('')).toEqual([]);
    expect(parseQueuesLabel('not-json')).toEqual([]);
    expect(parseQueuesLabel('{"a":1}')).toEqual([]);
    expect(parseQueuesLabel('[{"noName":true}]')).toEqual([]);
  });

  it('fills defaults for partial entries and drops invalid conventions to bullmq', () => {
    const [d] = parseQueuesLabel('[{"name":"q","cacheCluster":"main","convention":"kafka"}]');
    expect(d).toEqual({
      name: 'q',
      cacheCluster: 'main',
      convention: 'bullmq',
      scalePerJobs: 100,
      minWorkers: 1,
      maxWorkers: 5,
      retries: 3,
      dlq: true,
    });
  });

  it('keeps maxWorkers ≥ minWorkers', () => {
    const [d] = parseQueuesLabel(
      '[{"name":"q","cacheCluster":"main","minWorkers":8,"maxWorkers":2}]',
    );
    expect(d?.minWorkers).toBe(8);
    expect(d?.maxWorkers).toBe(8);
  });
});

describe('stats label codec', () => {
  it('round-trips a stats map', () => {
    const stats = {
      emails: { wait: 42, active: 3, failed: 1, delayed: 0, ts: '2026-07-02T00:00:00.000Z' },
    };
    expect(parseQueueStatsLabel(encodeQueueStatsLabel(stats))).toEqual(stats);
  });

  it('skips malformed entries, tolerates missing optional fields', () => {
    const parsed = parseQueueStatsLabel(
      '{"a":{"wait":1,"ts":"t"},"b":{"active":2},"c":"nope"}',
    );
    expect(parsed).toEqual({ a: { wait: 1, active: 0, failed: 0, delayed: 0, ts: 't' } });
    expect(parseQueueStatsLabel('[]')).toEqual({});
    expect(parseQueueStatsLabel('broken')).toEqual({});
  });
});

describe('parseCacheClusterRef', () => {
  it('bare cluster defaults to the worker stack', () => {
    expect(parseCacheClusterRef('main', 'storefront')).toEqual({
      stack: 'storefront',
      cluster: 'main',
    });
  });

  it('stack/cluster form is explicit', () => {
    expect(parseCacheClusterRef('platform/sessions', 'storefront')).toEqual({
      stack: 'platform',
      cluster: 'sessions',
    });
  });
});

describe('redis-cli command builders', () => {
  it('depth command probes all four BullMQ keys via one EVAL', () => {
    const cmd = depthCommand('valkey', BULL);
    expect(cmd).toStartWith('valkey-cli --no-auth-warning -a "$(cat /run/secrets/cache-password)"');
    expect(cmd).toContain(' 4 ');
    for (const k of ['bull:emails:wait', 'bull:emails:active', 'bull:emails:failed', 'bull:emails:delayed']) {
      expect(cmd).toContain(`'${k}'`);
    }
  });

  it('depth command probes only the raw list for the list convention', () => {
    const cmd = depthCommand('redis', LIST);
    expect(cmd).toStartWith('redis-cli ');
    expect(cmd).toContain(" 1 'outbox:webhooks'");
    expect(cmd).not.toContain('bull:');
  });

  it('retry command moves failed→wait with a bounded batch', () => {
    const cmd = retryFailedCommand('valkey', BULL, 50);
    expect(cmd).toContain("'bull:emails:failed' 'bull:emails:wait' 50");
    expect(cmd).toContain('ZPOPMIN');
    expect(() => retryFailedCommand('valkey', LIST, 50)).toThrow();
  });

  it('drain deletes wait+delayed (bullmq) or just the list (list)', () => {
    expect(drainCommand('valkey', BULL)).toContain("'bull:emails:wait' 'bull:emails:delayed'");
    const list = drainCommand('valkey', LIST);
    expect(list).toContain("1 'outbox:webhooks'");
    expect(list).not.toContain('ZCARD');
  });

  it('dlq list/requeue target the :dead list', () => {
    expect(dlqListCommand('redis', BULL, 50)).toContain("LRANGE 'emails:dead' 0 49");
    const rq = dlqRequeueCommand('redis', BULL, 25);
    expect(rq).toContain("'emails:dead' 'bull:emails:wait' 25");
    expect(rq).toContain('RPOPLPUSH');
  });

  it('shQuote wraps in single quotes and escapes embedded quotes', () => {
    expect(shQuote('a:b')).toBe("'a:b'");
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe('redis-cli output parsers', () => {
  it('parses raw-mode integers', () => {
    expect(parseRedisIntegers('5\n1\n2\n0\n')).toEqual([5, 1, 2, 0]);
  });

  it('parses tty-decorated integers and skips noise', () => {
    const raw = '1) (integer) 42\n2) (integer) 0\nNOAUTH nope\n(integer) 7';
    expect(parseRedisIntegers(raw)).toEqual([42, 0, 7]);
  });

  it('depth output → sample (bullmq needs 4 ints, list pads zeros)', () => {
    expect(parseDepthOutput('5\n1\n2\n0', 'bullmq')).toEqual({
      wait: 5,
      active: 1,
      failed: 2,
      delayed: 0,
    });
    expect(parseDepthOutput('9', 'list')).toEqual({ wait: 9, active: 0, failed: 0, delayed: 0 });
    expect(parseDepthOutput('9', 'bullmq')).toBeNull();
    expect(parseDepthOutput('ERR wrong number of args', 'list')).toBeNull();
  });

  it('parses LRANGE strings in raw and decorated modes', () => {
    expect(parseRedisStrings('{"id":1}\n{"id":2}')).toEqual(['{"id":1}', '{"id":2}']);
    expect(parseRedisStrings('1) "{\\"id\\":1}"\n2) "plain"')).toEqual(['{"id":1}', 'plain']);
    expect(parseRedisStrings('(empty array)')).toEqual([]);
    expect(parseRedisStrings('(empty list or set)')).toEqual([]);
  });
});
