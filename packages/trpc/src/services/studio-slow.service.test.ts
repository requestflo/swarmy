import { afterEach, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { prunePgQuerySamples, slowQueryTargets, snapshotSlowQueries, studioSlowQueries } from './studio-slow.service';

/**
 * The 24-hour slow-query store against a real (temp) telemetry.db: the
 * snapshot goes through the studio's system read (one `db.query`, audited as
 * `system`), only deltas are stored, and the view is org-scoped.
 */

const COLS = ['queryid', 'calls', 'total_ms', 'rows', 'query', 'sumsq_ms2', 'max_ms'];
let t: TestDb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

function harness(tdb: TestDb, replies: unknown[][][]) {
  const audit: Array<{ action: string; actorType: string; metadata: Record<string, unknown> }> = [];
  const queries: string[] = [];
  const primary = {
    id: 'svc-p', name: 'shop_main-primary', image: 'pgvector/pgvector:pg17', mode: 'replicated', runningReplicas: 1, createdAt: 0, updatedAt: 0,
    labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'main', 'swarmy.db.engine': 'postgres', 'swarmy.db.role': 'primary', 'swarmy.db.extensions.applied': 'pg_stat_statements' },
    networks: [], env: ['POSTGRES_PASSWORD=pw', 'POSTGRES_DB=app'], ports: [], mounts: [],
  };
  const containers = [{ id: 'c1', serviceId: 'svc-p', state: 'running', labels: {} }];
  const ctx = {
    db: { auditLog: { create: async ({ data }: { data: (typeof audit)[number] }) => (audit.push(data), {}) } },
    telemetry: tdb.telemetry,
    hub: {
      liveInventory: () => ({ services: [primary], containers }),
      onlineNodeIds: () => ['node1'],
      latestContainers: () => containers,
      dispatch: async (_n: string, cmd: string, payload: { op: { statement: string } }) => {
        if (cmd !== 'db.query') throw new Error(cmd);
        queries.push(payload.op.statement);
        return { engine: 'postgres', columns: COLS, rows: replies.shift() ?? [], rowCount: 1, truncated: false, notices: [], durationMs: 2 };
      },
    },
    user: null,
    membership: { role: 'owner', orgId: 'org1' },
    activeOrgId: 'org1',
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return { ctx, audit, queries };
}

describe('slow queries over 24 h', () => {
  it('finds managed clusters with pg_stat_statements applied from labels alone', async () => {
    t = await createTestDb();
    expect(slowQueryTargets(harness(t, []).ctx)).toEqual([{ stack: 'shop', target: 'main' }]);
  });

  it('baseline, then deltas; the view sums them with the exact spread and the slowest call, and no p95', async () => {
    t = await createTestDb();
    const h = harness(t, [
      [['7', '100', '1000', '100', 'SELECT * FROM orders WHERE id = $1', '10000', '10']],
      [['7', '150', '6000', '150', 'SELECT * FROM orders WHERE id = $1', '530000', '180']],
      [['7', '160', '6100', '160', 'SELECT * FROM orders WHERE id = $1', '531000', '180']],
    ]);
    const ref = { stack: 'shop', target: 'main' };
    const now = Date.parse('2026-10-24T10:00:00Z');
    const a = await snapshotSlowQueries(h.ctx, ref, null, new Date(now - 600_000));
    expect(a.written).toBe(0);
    const b = await snapshotSlowQueries(h.ctx, ref, a.totals, new Date(now - 300_000));
    const c = await snapshotSlowQueries(h.ctx, ref, b.totals, new Date(now));
    expect([b.written, c.written]).toEqual([1, 1]);
    expect(h.audit.map((x) => [x.action, x.actorType, x.metadata.origin])).toEqual(Array(3).fill(['studio.query', 'system', 'snapshot']));
    expect(h.queries[0]).toContain('FROM pg_stat_statements');

    const v = await studioSlowQueries(h.ctx, ref, now);
    expect(v.rows).toEqual([{ queryId: '7', query: 'SELECT * FROM orders WHERE id = $1', calls: 60, totalMs: 5100, meanMs: 85, stddevMs: 38.19, maxMs: 180, rows: 60, samples: 2 }]);
    expect(v.since).toBe(new Date(now - 300_000).toISOString());
    expect(v.note).toContain('no honest p95');

    const other = { ...h.ctx, activeOrgId: 'org2' } as OrgContext;
    expect((await studioSlowQueries(other, ref, now)).rows).toEqual([]);

    await prunePgQuerySamples(t.telemetry, new Date(now));
    expect(await t.telemetry.pgQuerySample.count()).toBe(1);
  });
});
