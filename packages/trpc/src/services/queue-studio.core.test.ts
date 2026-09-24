import { describe, expect, it } from 'bun:test';
import {
  StudioCleanInput,
  StudioJobsInput,
  buildQueueRatesQuery,
  chTime,
  ratePoint,
  renderQueueSamplesSchema,
} from './queue-studio.core';

describe('ratePoint — events since the last cursor → per-minute rates', () => {
  it('seeds on the first tick (no interval yet)', () => {
    expect(ratePoint(undefined, 1_000, { completed: 5, failed: 1, saturated: false })).toBeNull();
    expect(ratePoint({ lastId: null, at: 0 }, 1_000, { completed: 5, failed: 1, saturated: false })).toBeNull();
  });

  it('divides by the real interval and derives the failure ratio', () => {
    const p = ratePoint({ lastId: '1-0', at: 0 }, 30_000, { completed: 45, failed: 5, saturated: false });
    expect(p).toEqual({
      completed: 45,
      failed: 5,
      intervalSeconds: 30,
      throughput: 90,
      failureRate: 10,
      failureRatio: 0.1,
      saturated: false,
    });
  });

  it('has no failure ratio when nothing finished; carries saturation', () => {
    const p = ratePoint({ lastId: '1-0', at: 0 }, 15_000, { completed: 0, failed: 0, saturated: true })!;
    expect(p.failureRatio).toBeNull();
    expect(p.saturated).toBe(true);
  });
});

describe('observability store', () => {
  it('DDL is org-first, TTL-bounded and clamps retention', () => {
    const [create, ttl] = renderQueueSamplesSchema({ database: 'otel', retentionDays: 9999 });
    expect(create).toContain('CREATE TABLE IF NOT EXISTS otel.swarmy_queue_samples');
    expect(create).toContain('ORDER BY (org_id, stack, cluster, queue, ts)');
    expect(create).toContain('INTERVAL 365 DAY');
    expect(ttl).toBe('ALTER TABLE otel.swarmy_queue_samples MODIFY TTL toDateTime(ts) + INTERVAL 365 DAY');
    expect(() => renderQueueSamplesSchema({ database: 'x; DROP', retentionDays: 7 })).toThrow();
  });

  it('rates query is org-scoped and escapes every literal', () => {
    const sql = buildQueueRatesQuery('otel', "org'1", {
      stack: 'shop',
      cluster: 'jobs',
      prefix: 'bull',
      queue: "em'ails",
      windowMinutes: 60,
    });
    expect(sql).toContain("WHERE org_id = 'org\\'1'");
    expect(sql).toContain("queue = 'em\\'ails'");
    expect(sql).toContain('INTERVAL 60 MINUTE');
    expect(sql).toContain('INTERVAL 60 SECOND');
  });

  it('formats DateTime64 literals in UTC', () => {
    expect(chTime(Date.UTC(2026, 8, 24, 12, 0, 0, 5))).toBe('2026-09-24 12:00:00.005');
  });
});

describe('studio inputs', () => {
  it('refuse queue names BullMQ would reject and cleaning active jobs', () => {
    const ref = { stack: 'shop', cluster: 'jobs' };
    expect(() => StudioJobsInput.parse({ ...ref, queue: 'a:b', state: 'failed' })).toThrow();
    expect(() => StudioCleanInput.parse({ ...ref, queue: 'q', state: 'active' })).toThrow();
    expect(StudioJobsInput.parse({ ...ref, queue: 'emails', state: 'failed' })).toMatchObject({
      prefix: 'bull',
      start: 0,
      count: 25,
    });
  });
});
