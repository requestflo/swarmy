import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import { floatedExWriter, promotedCopySpec, reshapeStep } from './manageddb-reshape';

/** The reshape after promoting one copy of a multi-copy standby: one name, one writer. */

const svc = (labels: Record<string, string>, desired: number, running = desired, env: string[] = []): SwarmServiceInfo =>
  ({
    id: 'id-r',
    name: 'shop_db-replica',
    image: 'pgvector/pgvector:pg17',
    mode: 'replicated',
    desiredReplicas: desired,
    runningReplicas: running,
    labels,
    env,
    networks: [{ name: 'shop_db-net', aliases: [] }],
    secrets: ['shop_db-pg-password__v1'],
    configs: [],
    ports: [],
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as SwarmServiceInfo;

const W = { 'swarmy.db.role': 'primary', 'swarmy.db.failover.promoting': 'node-c', 'swarmy.db.dataVolume': 'shop_db-replica-data' };

describe('reshapeStep', () => {
  it('stops every copy, waits for them to go, then starts the one pinned copy', () => {
    expect(reshapeStep(svc(W, 2), 2)).toBe('stop');
    expect(reshapeStep(svc(W, 0, 1), 1)).toBe('wait');
    expect(reshapeStep(svc(W, 0, 0), 0)).toBe('pin');
  });
  it('a 1-copy writer pinned to the marked server is only unmarked; unpinned, it is pinned there; two copies are stopped', () => {
    expect(reshapeStep(svc({ ...W, 'swarmy.db.node': 'node-c' }, 1), 1)).toBe('unmark');
    expect(reshapeStep(svc(W, 1), 1)).toBe('pin');
    expect(reshapeStep(svc({ ...W, 'swarmy.db.node': 'node-a' }, 1), 1)).toBe('pin');
    expect(reshapeStep(svc(W, 1, 2), 2)).toBe('stop');
  });
  it('nothing to do without the mark, or for a standby carrying it (the promotion pass owns that)', () => {
    expect(reshapeStep(svc({ 'swarmy.db.role': 'primary' }, 2), 2)).toBe('none');
    expect(reshapeStep(svc({ ...W, 'swarmy.db.role': 'replica' }, 2), 2)).toBe('none');
  });
});

describe('promotedCopySpec', () => {
  it('one copy pinned to the promoted server, stop-first, its env (and rejoin epoch) unchanged', () => {
    const env = ['SWARMY_PG_ROLE=replica', 'SWARMY_PG_PRIMARY_HOST=shop_db-primary', 'SWARMY_PG_REJOIN=e1'];
    const labels = { ...W, 'swarmy.db.avoidNode': 'node-a', 'swarmy.db.rolePlaced': 'true', 'swarmy.db.failover.pending': '{}', 'swarmy.db.region': 'eu' };
    const spec = promotedCopySpec(svc(labels, 0, 0, env), 'node-c', 'shop_db-net');
    expect(spec.mode).toEqual({ replicated: { replicas: 1 } });
    expect(spec.updateConfig).toEqual({ parallelism: 1, order: 'stop-first' });
    expect(spec.placement?.constraints).toEqual(['node.labels.swarmy.region==eu', 'node.id==node-c']);
    expect(spec.placement?.maxReplicasPerNode).toBe(1);
    expect(spec.mounts?.[0]).toEqual({ type: 'volume', source: 'shop_db-replica-data', target: '/var/lib/postgresql/data' });
    expect(spec.env?.SWARMY_PG_ROLE).toBe('replica');
    expect(spec.env?.SWARMY_PG_REJOIN).toBe('e1');
    expect(spec.labels?.['swarmy.db.node']).toBe('node-c');
    expect(spec.labels?.['swarmy.db.leader']).toBe('shop_db-replica');
    for (const gone of ['swarmy.db.avoidNode', 'swarmy.db.rolePlaced', 'swarmy.db.failover.promoting', 'swarmy.db.failover.pending']) {
      expect(spec.labels?.[gone]).toBeUndefined();
    }
  });
});

describe('floatedExWriter', () => {
  it('drops the pin, avoids the new writer, carries the standby copies', () => {
    const ex = floatedExWriter(svc({ 'swarmy.db.node': 'node-a', 'swarmy.db.dataVolume': 'shop_db-primary-data' }, 1), 'node-c', 2);
    expect(ex.labels['swarmy.db.node']).toBeUndefined();
    expect(ex.labels['swarmy.db.avoidNode']).toBe('node-c');
    expect(ex.labels['swarmy.db.dataVolume']).toBe('shop_db-primary-data');
    expect(ex.desiredReplicas).toBe(2);
  });
});
