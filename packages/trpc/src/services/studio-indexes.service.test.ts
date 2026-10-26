import { describe, expect, it } from 'bun:test';
import { STACK_LABEL } from '@swarmy/core';
import type { OrgContext } from '../context';
import { studioIndexAdvice } from './studio-indexes.service';

/**
 * `studio.indexAdvice`: one studio read of the database's statistics (gated
 * as the person, audited under origin `indexes`), the pure rules over it,
 * and the standby caveat when the cluster has running standby copies.
 */

const FACTS = JSON.stringify({
  reset: '2026-09-01T03:00:00+00:00',
  tables: [{ tbl: 'order_items', seq_scan: 1_200, seq_tup_read: 1_200 * 412_000, idx_scan: 12, live: 412_000, bytes: 64 << 20 }],
  indexes: [{ idx: 'order_items_old_idx', tbl: 'order_items', idx_scan: 0, bytes: 48 << 20, enforces: false }],
  fks: [{ tbl: 'order_items', name: 'order_items_cart_id_fkey', ref: 'carts', keys: [2], cols: ['cart_id'], idx_keys: ['1'], live: 412_000 }],
});

const svc = (id: string, name: string, labels: Record<string, string>, image = 'pgvector/pgvector:pg17') => ({
  id, name, image, mode: 'replicated', runningReplicas: 1, createdAt: 0, updatedAt: 0,
  labels: { [STACK_LABEL]: 'shop', ...labels }, networks: [], env: ['POSTGRES_PASSWORD=pw', 'POSTGRES_DB=app'], ports: [], mounts: [],
});
const pgLabels = (role: string) => ({ 'swarmy.db.cluster': 'main', 'swarmy.db.engine': 'postgres', 'swarmy.db.role': role });

function harness(opts: { replica?: boolean } = {}) {
  const audit: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const sent: Array<{ cmd: string; statement: string; database?: string }> = [];
  const services = [
    svc('svc-p', 'shop_main-primary', pgLabels('primary')),
    ...(opts.replica ? [svc('svc-r', 'shop_main-replica', pgLabels('replica'))] : []),
    { ...svc('svc-c', 'shop_cache', {}, 'valkey/valkey:8'), env: [] },
  ];
  const byNode: Record<string, unknown[]> = { 'n-1': [{ id: 'aaaaaaaaaaaa1111', serviceId: 'svc-p', state: 'running', labels: {} }] };
  const ctx = {
    db: {
      member: { findFirst: async () => ({ id: 'mem1', role: 'member', organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      auditLog: { create: async ({ data }: { data: (typeof audit)[number] }) => (audit.push(data), {}) },
    },
    hub: {
      liveInventory: () => ({ services, containers: Object.values(byNode).flat() }),
      onlineNodeIds: () => Object.keys(byNode),
      latestContainers: (n: string) => byNode[n] ?? [],
      nodeInfoFor: () => undefined,
      dispatch: async (_n: string, cmd: string, payload: { op: { statement: string }; database?: string }) => {
        sent.push({ cmd, statement: payload.op.statement, database: payload.database });
        return { engine: 'postgres', columns: ['facts'], rows: [[FACTS]], rowCount: 1, truncated: false, notices: [], durationMs: 3 };
      },
    },
    session: { id: 's1' },
    user: { id: 'user1', email: 'u@example.com', name: 'u' },
    membership: { role: 'member', orgId: 'org1' },
    activeOrgId: 'org1',
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return { ctx, audit, sent };
}

describe('studio.indexAdvice', () => {
  it('one audited read of the statistics → tips to copy, in order: foreign keys, full reads, unused indexes', async () => {
    const h = harness();
    const v = await studioIndexAdvice(h.ctx, { stack: 'shop', target: 'main' });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.cmd).toBe('db.query');
    expect(h.sent[0]!.statement).toContain('FROM pg_stat_user_tables');
    expect(h.sent[0]!.database).toBe('app');
    expect(h.audit.map((a) => [a.action, a.metadata?.origin, a.metadata?.class])).toEqual([['studio.query', 'indexes', 'read']]);
    expect(v.tips.map((t) => [t.kind, t.sql])).toEqual([
      ['fk-unindexed', 'CREATE INDEX CONCURRENTLY ON order_items (cart_id);'],
      ['seq-scans', 'CREATE INDEX CONCURRENTLY ON order_items (/* the column its queries filter by */);'],
      ['unused-index', 'DROP INDEX CONCURRENTLY order_items_old_idx;'],
    ]);
    expect([v.statsSince, v.standbys, v.checked, v.unavailable]).toEqual(['2026-09-01T03:00:00+00:00', 0, { tables: 1, indexes: 1, foreignKeys: 1 }, null]);
  });

  it('a running standby copy adds the caveat to the unused-index tip', async () => {
    const v = await studioIndexAdvice(harness({ replica: true }).ctx, { stack: 'shop', target: 'main', database: 'app' });
    expect(v.standbys).toBe(1);
    expect(v.tips.find((t) => t.kind === 'unused-index')!.why).toContain('check there before dropping it');
  });

  it('not Postgres: says so and reads nothing; an unknown database is not found', async () => {
    const h = harness();
    const v = await studioIndexAdvice(h.ctx, { stack: 'shop', target: 'shop_cache' });
    expect(v.unavailable).toContain('for Postgres');
    expect(h.sent).toEqual([]);
    await expect(studioIndexAdvice(h.ctx, { stack: 'shop', target: 'nope' })).rejects.toThrow(/not found/i);
  });
});
