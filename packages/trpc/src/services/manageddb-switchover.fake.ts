import { DB_FAILOVER_PENDING_LABEL, DB_POOLER_TARGET_LABEL, DB_SWITCHOVER_LABEL, STACK_LABEL } from '@swarmy/core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import type { SwitchoverIo } from './manageddb-switchover.steps';

/**
 * TEST HELPER — a fake swarm for the planned-switchover tests: a writer on
 * wkr-1, one standby on wkr-2, an optional pooler and app. `db.query` answers
 * `pg_stat_replication` like the studio read; `service.scale` of the writer to
 * 0 plays the reconcile's promotion pass (`promote`): it promotes, holds, or
 * never comes. `psql` plays both Postgres copies: the standby replays up to
 * the writer's final position once writes are paused, unless `lagStuck`.
 */

export interface FakeOpts {
  promote?: 'yes' | 'hold' | 'never';
  lagStuck?: boolean;
  /** The standby's state and lag as pg_stat_replication reports them. */
  row?: { state: string; lagBytes: number | null } | null;
  shared?: boolean;
  pooler?: boolean;
  /** An app wired to the cluster: 'direct' or through the pooler. */
  app?: 'direct' | 'pooler';
  /** The old writer never comes back after the switch. */
  noRejoin?: boolean;
  /** psql in the writer fails at this statement (substring). */
  failAt?: string;
  /** The copy ran pg_promote but its labels haven't flipped yet. */
  promotedUnlabelled?: boolean;
  /** What the writer answers for its flushed position. */
  flushLsn?: string;
}

const COLS = ['name', 'addr', 'state', 'sync_state', 'sent_lsn', 'replay_lsn', 'primary_lsn', 'lag_bytes', 'lag_seconds'];

function svc(id: string, name: string, labels: Record<string, string>, replicas = 1): SwarmServiceInfo {
  return {
    id, name, image: 'managed-pg', mode: 'replicated', desiredReplicas: replicas, runningReplicas: replicas, createdAt: 0, updatedAt: 0,
    labels: { [STACK_LABEL]: 'shop', ...labels }, networks: [], env: ['POSTGRES_PASSWORD=pw', 'POSTGRES_DB=app'], ports: [], secrets: [], configs: [], mounts: [],
  } as SwarmServiceInfo;
}

export function fakeSwitchover(o: FakeOpts = {}) {
  const pg = { 'swarmy.db.cluster': 'db', 'swarmy.db.engine': 'postgres', 'swarmy.db.topology': 'primary-replica' };
  const primary = svc('svc-p', 'shop_db-primary', { ...pg, 'swarmy.db.role': 'primary' });
  const replica = svc('svc-r', 'shop_db-replica', { ...pg, 'swarmy.db.role': 'replica' }, o.shared ? 2 : 1);
  const services = [primary, replica];
  if (o.pooler) services.push(svc('svc-b', 'shop_db-pooler', { 'swarmy.db.cluster': 'db', 'swarmy.db.role': 'pooler', [DB_POOLER_TARGET_LABEL]: primary.name }));
  if (o.app) services.push(svc('svc-a', 'shop_api', { 'swarmy.db.inject': 'db', ...(o.app === 'pooler' ? { 'swarmy.db.inject.via': 'pooler' } : {}) }));
  const byName = (n: string) => services.find((s) => s.name === n)!;
  const containers = () => [
    ...((primary.runningReplicas ?? 0) > 0 ? [{ id: 'aaaaaaaaaaaa0001', serviceId: 'svc-p', node: 'n1' }] : []),
    { id: '3f2a9c1b7d4e0002', serviceId: 'svc-r', node: 'n2' },
  ].map((c) => ({ ...c, state: 'running', labels: {} }));
  const calls: Array<{ cmd: string; payload: Record<string, unknown> }> = [];
  const audit: string[] = [];
  const hub = {
    liveInventory: () => ({ services, containers: containers() }),
    onlineNodeIds: () => ['n1', 'n2'],
    latestContainers: (n: string) => containers().filter((c) => c.node === n),
    nodeInfoFor: (n: string) => ({ hostname: n === 'n1' ? 'wkr-1' : 'wkr-2' }),
    managerNode: () => 'n1',
    isOnline: () => true,
    swarmNodeIdFor: (n: string) => `sw-${n}`,
    dispatch: async (_n: string, cmd: string, payload: Record<string, any>) => {
      calls.push({ cmd, payload });
      if (cmd === 'db.query') {
        const r = o.row === undefined ? { state: 'streaming', lagBytes: 120 } : o.row;
        const rows = r ? [['3f2a9c1b7d4e', '10.0.4.7/32', r.state, 'async', '0/3000000', '0/2FFFF88', '0/3000000', r.lagBytes === null ? null : String(r.lagBytes), '0.1']] : [];
        return { engine: 'postgres', columns: COLS, rows, rowCount: rows.length, truncated: false, notices: [], durationMs: 2 };
      }
      if (cmd === 'service.updateLabels') {
        const s = byName(payload.service);
        Object.assign(s.labels, payload.add);
        for (const k of payload.removeKeys as string[]) delete s.labels[k];
      }
      if (cmd === 'service.scale') {
        const s = byName(payload.service);
        s.desiredReplicas = payload.replicas;
        s.runningReplicas = s === primary && payload.replicas > 0 && o.noRejoin ? 0 : payload.replicas;
        if (s === primary && payload.replicas === 0) reconcile();
      }
      return {};
    },
  };
  // The promotion pass, as the reconcile runs it once the writer stops.
  const reconcile = () => {
    if (o.promote === 'never') return;
    if (o.promote === 'hold') {
      primary.labels[DB_FAILOVER_PENDING_LABEL] = '{"target":"shop_db-replica","behindBytes":null}';
      return;
    }
    replica.labels['swarmy.db.role'] = 'primary';
    primary.labels['swarmy.db.role'] = 'replica';
    delete primary.labels[DB_SWITCHOVER_LABEL];
    const pooler = services.find((s) => s.labels['swarmy.db.role'] === 'pooler');
    if (pooler) pooler.labels[DB_POOLER_TARGET_LABEL] = replica.name;
  };
  const sql: string[] = [];
  let frozen = false;
  let t = 0;
  const io: SwitchoverIo = {
    now: () => (t += 1000),
    sleep: async () => {},
    psql: async (service, q) => {
      sql.push(`${service}: ${q}`);
      if (o.failAt && service === primary.name && q.includes(o.failAt)) throw new Error(`exec exited 1: ${o.failAt}`);
      if (q.includes('read_only = on')) frozen = true;
      if (q.includes('RESET default_transaction_read_only')) frozen = false;
      if (q.includes('pg_current_wal_flush_lsn')) return o.flushLsn ?? '0/3000000\n';
      if (q.includes('pg_last_wal_replay_lsn')) return o.lagStuck || !frozen ? '0/2FFFF00' : '0/3000000';
      if (q.includes('pg_is_in_recovery')) return o.promotedUnlabelled || replica.labels['swarmy.db.role'] === 'primary' ? 'f' : 't';
      return '';
    },
  };
  const ctx = {
    db: {
      member: { findFirst: async () => ({ id: 'mem1', role: 'owner', organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      incident: { findMany: async () => [] },
      auditLog: { create: async ({ data }: { data: { action: string } }) => (audit.push(data.action), {}) },
    },
    hub,
    session: { id: 's1' },
    user: { id: 'user1', email: 'u@example.com', name: 'u' },
    membership: { role: 'owner', orgId: 'org1' },
    activeOrgId: 'org1',
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return { ctx, io, calls, sql, audit, primary, replica, frozen: () => frozen, services };
}
