import { describe, expect, it } from 'bun:test';
import { STACK_LABEL } from '@swarmy/core';
import type { OrgContext } from '../context';
import { getDbReplication } from './manageddb-replication.service';

/**
 * `db.replication`: one studio read on the primary (gated as the person,
 * audited under its own origin), each `pg_stat_replication` row matched back
 * to its task and server by the container-hostname prefix.
 */

const COLS = ['name', 'addr', 'state', 'sync_state', 'sent_lsn', 'replay_lsn', 'primary_lsn', 'lag_bytes', 'lag_seconds'];
const pg = (id: string, name: string, role: string) => ({
  id, name, image: 'pgvector/pgvector:pg17', mode: 'replicated', runningReplicas: 1, createdAt: 0, updatedAt: 0,
  labels: { [STACK_LABEL]: 'shop', 'swarmy.db.cluster': 'main', 'swarmy.db.engine': 'postgres', 'swarmy.db.role': role },
  networks: [], env: ['POSTGRES_PASSWORD=pw', 'POSTGRES_DB=app'], ports: [], mounts: [],
});

function harness(role: 'owner' | 'member', rows: unknown[][]) {
  const audit: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const sent: Array<{ cmd: string; statement: string }> = [];
  const services = [pg('svc-p', 'shop_main-primary', 'primary'), pg('svc-r', 'shop_main-replica', 'replica')];
  const byNode: Record<string, unknown[]> = {
    'n-1': [{ id: 'aaaaaaaaaaaa1111', serviceId: 'svc-p', state: 'running', labels: {} }],
    'n-2': [{ id: '3f2a9c1b7d4e9999', serviceId: 'svc-r', state: 'running', labels: {} }],
  };
  const containers = Object.values(byNode).flat();
  const ctx = {
    db: {
      member: { findFirst: async () => ({ id: 'mem1', role, organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      auditLog: { create: async ({ data }: { data: (typeof audit)[number] }) => (audit.push(data), {}) },
    },
    hub: {
      liveInventory: () => ({ services, containers }),
      onlineNodeIds: () => Object.keys(byNode),
      latestContainers: (n: string) => byNode[n] ?? [],
      nodeInfoFor: () => undefined,
      dispatch: async (_n: string, cmd: string, payload: { op: { statement: string } }) => {
        sent.push({ cmd, statement: payload.op.statement });
        return { engine: 'postgres', columns: COLS, rows, rowCount: rows.length, truncated: false, notices: [], durationMs: 2 };
      },
    },
    session: { id: 's1' },
    user: { id: 'user1', email: 'u@example.com', name: 'u' },
    membership: { role, orgId: 'org1' },
    activeOrgId: 'org1',
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return { ctx, audit, sent };
}

describe('db.replication', () => {
  it('reads pg_stat_replication on the primary and names each row after its task and server', async () => {
    const h = harness('owner', [
      ['3f2a9c1b7d4e', '10.0.4.7/32', 'streaming', 'async', '0/3000148', '0/3000060', '0/3000148', '232', '0.4'],
      ['pg_basebackup', '10.0.4.9/32', 'backup', 'async', null, null, '0/3000148', null, null],
    ]);
    const v = await getDbReplication(h.ctx, { stack: 'shop', cluster: 'main' });
    expect(v.primaryLsn).toBe('0/3000148');
    expect(v.standbys.map((s) => [s.name, s.service, s.nodeId, s.replayLsn, s.lagBytes, s.lagSeconds])).toEqual([
      ['3f2a9c1b7d4e', 'shop_main-replica', 'n-2', '0/3000060', 232, 0.4],
      ['pg_basebackup', null, null, null, null, null],
    ]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.cmd).toBe('db.query');
    expect(h.sent[0]!.statement).toContain('FROM (SELECT 1) AS one LEFT JOIN pg_stat_replication');
    expect(h.audit.map((a) => [a.action, a.metadata?.origin, a.metadata?.class])).toEqual([['studio.query', 'replication', 'read']]);
  });

  it('no standby connected: the primary LSN and an empty list', async () => {
    const h = harness('owner', [[null, null, null, null, null, null, '0/5A1B2C3', null, null]]);
    const v = await getDbReplication(h.ctx, { stack: 'shop', cluster: 'main' });
    expect([v.primaryLsn, v.standbys]).toEqual(['0/5A1B2C3', []]);
  });

  it('an unknown cluster is not found, and nothing is sent', async () => {
    const h = harness('owner', []);
    await expect(getDbReplication(h.ctx, { stack: 'shop', cluster: 'nope' })).rejects.toThrow(/not found/i);
    expect(h.sent).toEqual([]);
  });
});
