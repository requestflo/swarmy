import { describe, expect, it } from 'bun:test';
import { STACK_LABEL } from '@swarmy/core';
import type { OrgContext } from '../context';
import { getDbWrites, readWritesBeforeSave } from './dbWrites.service';

/**
 * Rows written since a save: the primary's write counters read just before
 * the save (as the system, only with a running task), read again live (as
 * the person, origin `writes`), subtracted per save, or "started again".
 */

const svc = {
  id: 'svc-p', name: 'shop_main-primary', image: 'pgvector/pgvector:pg17', mode: 'replicated', runningReplicas: 1, createdAt: 0, updatedAt: 0,
  labels: { [STACK_LABEL]: 'shop', 'swarmy.db.cluster': 'main', 'swarmy.db.engine': 'postgres', 'swarmy.db.role': 'primary' },
  networks: [], env: ['POSTGRES_PASSWORD=pw', 'POSTGRES_DB=app'], ports: [], mounts: [],
};
const FULL = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';

function harness(opts: { running?: boolean; live?: string[] } = {}) {
  const audit: Array<{ action: string; actorType?: string; metadata?: Record<string, unknown> }> = [];
  const sent: string[] = [];
  const containers = opts.running === false ? [] : [{ id: 'c1', serviceId: 'svc-p', state: 'running', labels: {} }];
  const saved = [
    { metadata: { engine: 'pg_dump', snapshotId: FULL, writes: { rows: 1_000, serverStart: 10, statsReset: 0 } } },
    { metadata: { engine: 'pg_dump', snapshotId: 'ffff0000aaaa', writes: { rows: 50, serverStart: 9, statsReset: 0 } } },
    { metadata: { engine: 'pg_dump', snapshotId: 'eeee0000bbbb' } },
  ];
  const ctx = {
    db: {
      member: { findFirst: async () => ({ id: 'mem1', role: 'member', organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      auditLog: {
        create: async ({ data }: { data: (typeof audit)[number] }) => (audit.push(data), {}),
        findMany: async () => saved,
      },
    },
    hub: {
      liveInventory: () => ({ services: [svc], containers }),
      onlineNodeIds: () => ['n-1'],
      latestContainers: () => containers,
      nodeInfoFor: () => undefined,
      dispatch: async (_n: string, cmd: string, payload: { op: { statement: string } }) => {
        sent.push(`${cmd}:${payload.op.statement.slice(0, 40)}`);
        return { engine: 'postgres', columns: ['rows', 'server_start', 'stats_reset'], rows: [opts.live ?? ['13500', '10', '0']], rowCount: 1, truncated: false, notices: [], durationMs: 2 };
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

describe('dbWrites', () => {
  it('reads the counters before a save as the system, and not at all without a running primary', async () => {
    const h = harness();
    expect(await readWritesBeforeSave(h.ctx, 'shop', 'main', 'shop_main-primary')).toEqual({ rows: 13_500, serverStart: 10, statsReset: 0 });
    expect(h.audit.map((a) => [a.action, a.actorType, a.metadata?.origin])).toEqual([['studio.query', 'system', 'snapshot']]);
    const idle = harness({ running: false });
    expect(await readWritesBeforeSave(idle.ctx, 'shop', 'main', 'shop_main-primary')).toBeNull();
    expect(idle.sent).toEqual([]);
  });

  it('counts the rows since each save that recorded them, by restic short id; a restart since says so', async () => {
    const h = harness();
    const v = await getDbWrites(h.ctx, { stack: 'shop', cluster: 'main' });
    expect(v).toEqual({
      read: true,
      database: 'app',
      countingSince: new Date(10_000).toISOString(),
      saves: [
        { snapshotId: 'a1b2c3d4', since: { status: 'counted', rows: 12_500 } },
        { snapshotId: 'ffff0000', since: { status: 'reset' } },
      ],
    });
    expect(h.audit.map((a) => a.metadata?.origin)).toEqual(['writes']);
  });

  it('says nothing per save when the live counters can’t be read', async () => {
    const v = await getDbWrites(harness({ live: ['x'] }).ctx, { stack: 'shop', cluster: 'main' });
    expect(v).toMatchObject({ read: false, saves: [] });
  });
});
