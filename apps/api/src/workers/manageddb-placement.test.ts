import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import { planReplicaScale } from './manageddb-reconcile.core';
import { regionReplicaSpec, repointSpec } from './manageddb-reconcile';

/**
 * Database-role placement in the manageddb-reconcile worker: geo siblings and
 * repointed replicas prefer `swarmy.node.database` servers within their
 * region, falling back to the region-only placement; a role-placed replica
 * scaled past the role servers is rebuilt, not left pending.
 */

const node = (id: string, labels: Record<string, string>) => ({
  swarmNodeId: id,
  status: 'ready',
  availability: 'active',
  labels,
});
const DB = { 'swarmy.node.database': 'true' };
const NODES = [
  node('pin', { 'swarmy.region': 'eu', ...DB }),
  node('eu-db', { 'swarmy.region': 'eu', ...DB }),
  node('eu-plain', { 'swarmy.region': 'eu' }),
  node('us-plain', { 'swarmy.region': 'us' }),
];

const svc = (name: string, labels: Record<string, string>, desired = 1): SwarmServiceInfo => ({
  id: `id-${name}`,
  name,
  image: 'pgvector/pgvector:pg17',
  mode: 'replicated',
  desiredReplicas: desired,
  runningReplicas: desired,
  createdAt: 0,
  updatedAt: 0,
  labels,
  networks: [{ name: 'shop_pg-net', aliases: [] }],
  env: ['POSTGRES_PASSWORD_FILE=/run/secrets/shop_pg-pg-password'],
  ports: [],
  secrets: [],
  configs: [],
});

const cluster = { stack: 'shop', cluster: 'pg', base: 'shop_pg', extraPrimaries: new Map(), regionReplicas: new Map() };
const primary = svc('shop_pg-primary', { 'swarmy.db.role': 'primary', 'swarmy.db.node': 'pin' });

describe('regionReplicaSpec — role servers within the region, else region only', () => {
  it('one task, one eu role server off the primary pin ⇒ region + role constraint and the marker', () => {
    const spec = regionReplicaSpec(cluster, primary, 'eu', 1, true, NODES);
    expect(spec.placement?.constraints).toEqual([
      'node.labels.swarmy.region==eu',
      'node.labels.swarmy.node.database==true',
      'node.id!=pin',
    ]);
    expect(spec.labels?.['swarmy.db.rolePlaced']).toBe('true');
  });

  it('two tasks but one usable role server ⇒ today (region only), no marker', () => {
    const spec = regionReplicaSpec(cluster, primary, 'eu', 2, true, NODES);
    expect(spec.placement?.constraints).toEqual(['node.labels.swarmy.region==eu', 'node.id!=pin']);
    expect(spec.labels?.['swarmy.db.rolePlaced']).toBeUndefined();
  });

  it('no role server in the region, or no node inventory ⇒ region only', () => {
    expect(regionReplicaSpec(cluster, primary, 'us', 1, true, NODES).placement?.constraints).toEqual([
      'node.labels.swarmy.region==us',
      'node.id!=pin',
    ]);
    expect(regionReplicaSpec(cluster, primary, 'eu', 1, true).placement?.constraints).toEqual([
      'node.labels.swarmy.region==eu',
      'node.id!=pin',
    ]);
  });
});

describe('repointSpec — a floating replica keeps preferring the role; the pinned ex-primary stays put', () => {
  it('floating base replica is re-placed on the role when there is room', () => {
    const replica = svc('shop_pg-replica', { 'swarmy.db.role': 'replica', 'swarmy.db.avoidNode': 'pin' });
    const spec = repointSpec(replica, 'shop_pg-replica-eu', 'shop_pg-net', 'e1', NODES);
    expect(spec.placement?.constraints).toEqual(['node.labels.swarmy.node.database==true', 'node.id!=pin']);
    expect(spec.labels?.['swarmy.db.rolePlaced']).toBe('true');
  });

  it('the pinned ex-primary gets its pin only (no role constraint), with or without nodes', () => {
    const demoted = svc('shop_pg-primary', { 'swarmy.db.role': 'primary', 'swarmy.db.node': 'pin', 'swarmy.db.dataVolume': 'v' });
    for (const nodes of [NODES, undefined]) {
      const spec = repointSpec(demoted, 'shop_pg-replica', 'shop_pg-net', 'e1', nodes);
      expect(spec.placement?.constraints).toEqual(['node.id==pin']);
      expect(spec.labels?.['swarmy.db.rolePlaced']).toBeUndefined();
    }
  });
});

describe('planReplicaScale — scale, or rebuild a role-placed replica that outgrew the role servers', () => {
  const marked = { 'swarmy.db.rolePlaced': 'true' };
  it('steady state does nothing; a count change scales', () => {
    expect(planReplicaScale({ labels: marked, desired: 1, target: 1, nodes: NODES, avoidNode: 'pin' })).toBe('none');
    expect(planReplicaScale({ labels: {}, desired: 1, target: 3, nodes: NODES })).toBe('scale');
  });

  it('a role-placed replica scaled past the role servers is rebuilt (fallback placement)', () => {
    expect(planReplicaScale({ labels: marked, desired: 1, target: 2, nodes: NODES, avoidNode: 'pin' })).toBe('rebuild');
    // Within the region the same rule: one eu role server off the pin.
    expect(planReplicaScale({ labels: marked, desired: 1, target: 2, nodes: NODES, region: 'eu', avoidNode: 'pin' })).toBe('rebuild');
    // Parking at 0 never rebuilds.
    expect(planReplicaScale({ labels: marked, desired: 1, target: 0, nodes: NODES })).toBe('scale');
  });
});
