import { describe, expect, it } from 'bun:test';
import {
  DB_FAILOVER_CONFIRM_LABEL,
  DB_FAILOVER_PENDING_LABEL,
  encodePendingFailover,
  parseFailoverConfirmation,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { confirmFailover, getDbTopology } from './manageddb.service';

/**
 * The admin half of "no silent data loss on failover": a HELD failover is read
 * off the `swarmy.db.failover.pending` label, and `confirmFailover` stamps a
 * confirmation that names the target + the accepted window (the worker does
 * the promotion). Pure mocks — no Docker, no DB.
 */

const PENDING = {
  target: 'app_db-replica-eu',
  behindBytes: 4096 as number | null,
  behindSeconds: 2.5,
  reason: "the most caught-up replica is 4096 bytes behind the primary's last flushed position",
  since: '2026-09-24T12:00:00.000Z',
};

function svc(name: string, labels: Record<string, string>) {
  return {
    id: name, name, image: 'pgvector/pgvector:pg17', mode: 'replicated', replicas: 1,
    runningReplicas: name.includes('primary') ? 0 : 1, desiredReplicas: 1,
    labels: { 'com.docker.stack.namespace': 'app', 'swarmy.db.engine': 'postgres', 'swarmy.db.cluster': 'db', ...labels },
    networks: [], env: [], ports: [], createdAt: 0, updatedAt: 0,
  };
}

function ctxWith(pending: typeof PENDING | null) {
  const dispatched: Array<{ cmd: string; payload: { service: string; add: Record<string, string> } }> = [];
  const audit: Array<{ action: string; metadata?: unknown }> = [];
  const services = [
    svc('app_db-primary', {
      'swarmy.db.role': 'primary',
      'swarmy.db.topology': 'geo',
      ...(pending ? { [DB_FAILOVER_PENDING_LABEL]: encodePendingFailover(pending) } : {}),
    }),
    svc('app_db-replica-eu', { 'swarmy.db.role': 'replica', 'swarmy.db.region': 'eu' }),
    svc('app_db-replica-us', { 'swarmy.db.role': 'replica', 'swarmy.db.region': 'us' }),
  ];
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'admin1' },
    hub: {
      liveInventory: () => ({ services, containers: [] }),
      managerNode: () => 'mgr1',
      isOnline: () => true,
      dispatch: async (_node: string, cmd: string, payload: { service: string; add: Record<string, string> }) => {
        dispatched.push({ cmd, payload });
        return {};
      },
    },
    db: {
      auditLog: {
        create: async ({ data }: { data: { action: string; metadata?: unknown } }) => {
          audit.push(data);
          return {};
        },
      },
    },
  } as unknown as OrgContext;
  return { ctx, dispatched, audit };
}

describe('held failover — dashboard/API view', () => {
  it('surfaces the pending window on the cluster view', () => {
    const { ctx } = ctxWith(PENDING);
    const view = getDbTopology(ctx, 'app').clusters[0]!;
    expect(view.pendingFailover).toEqual(PENDING);
  });

  it('no pending label ⇒ no pendingFailover', () => {
    const { ctx } = ctxWith(null);
    expect(getDbTopology(ctx, 'app').clusters[0]!.pendingFailover).toBeUndefined();
  });
});

describe('confirmFailover', () => {
  it('stamps a confirmation (target + accepted window + who) on the holder and audits it', async () => {
    const { ctx, dispatched, audit } = ctxWith(PENDING);
    await confirmFailover(ctx, { stack: 'app', cluster: 'db', target: 'app_db-replica-eu', acceptBehindBytes: 4096 });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.cmd).toBe('service.updateLabels');
    expect(dispatched[0]!.payload.service).toBe('app_db-primary');
    const c = parseFailoverConfirmation(dispatched[0]!.payload.add[DB_FAILOVER_CONFIRM_LABEL]);
    expect(c).toMatchObject({ target: 'app_db-replica-eu', acceptBehindBytes: 4096, by: 'admin1' });
    expect(audit.map((a) => a.action)).toEqual(['db.failover.confirm']);
  });

  it('refuses a window smaller than the one swarmy is showing', async () => {
    const { ctx, dispatched } = ctxWith(PENDING);
    await expect(
      confirmFailover(ctx, { stack: 'app', cluster: 'db', target: 'app_db-replica-eu', acceptBehindBytes: 100 }),
    ).rejects.toThrow('review it again');
    expect(dispatched).toHaveLength(0);
  });

  it('refuses a numeric window when the window is unknown; "unknown" accepts it', async () => {
    const unknown = { ...PENDING, behindBytes: null };
    await expect(
      confirmFailover(ctxWith(unknown).ctx, { stack: 'app', cluster: 'db', target: PENDING.target, acceptBehindBytes: 1e9 }),
    ).rejects.toThrow('unknown');
    const ok = ctxWith(unknown);
    await confirmFailover(ok.ctx, { stack: 'app', cluster: 'db', target: PENDING.target, acceptBehindBytes: 'unknown' });
    expect(ok.dispatched).toHaveLength(1);
  });

  it('refuses when nothing is waiting, or the target is not a replica of the cluster', async () => {
    await expect(
      confirmFailover(ctxWith(null).ctx, { stack: 'app', cluster: 'db', target: PENDING.target, acceptBehindBytes: 0 }),
    ).rejects.toThrow('no failover waiting');
    await expect(
      confirmFailover(ctxWith(PENDING).ctx, { stack: 'app', cluster: 'db', target: 'app_db-primary', acceptBehindBytes: 'unknown' }),
    ).rejects.toThrow('not a replica');
  });

  it('an admin may choose another replica (the worker re-checks ITS window before promoting)', async () => {
    const { ctx, dispatched } = ctxWith(PENDING);
    await confirmFailover(ctx, { stack: 'app', cluster: 'db', target: 'app_db-replica-us', acceptBehindBytes: 'unknown' });
    expect(parseFailoverConfirmation(dispatched[0]!.payload.add[DB_FAILOVER_CONFIRM_LABEL])?.target).toBe('app_db-replica-us');
  });
});
