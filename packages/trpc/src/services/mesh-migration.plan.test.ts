import { describe, expect, it } from 'bun:test';
import type { SwarmNodeInfo } from '@swarmy/core/protocol';
import {
  isMeshCidr,
  isOnMesh,
  labelsToRestore,
  planMeshMigration,
  planPinRemap,
  remapConstraints,
  snapshotNodeSpec,
  type PlanNodeInput,
  type PlanServiceInput,
} from './mesh-migration.plan';

function swarm(over: Partial<SwarmNodeInfo> & { swarmNodeId: string; hostname: string }): SwarmNodeInfo {
  return {
    role: 'worker',
    availability: 'active',
    status: 'ready',
    leader: false,
    labels: {},
    ...over,
  };
}

function node(
  id: string,
  over: Partial<SwarmNodeInfo> = {},
  extra: Partial<PlanNodeInput> = {},
): PlanNodeInput {
  return {
    nodeId: id,
    hostname: id,
    online: true,
    meshConnected: false,
    swarm: swarm({ swarmNodeId: `sw-${id}`, hostname: id, addr: '203.0.113.1', ...over }),
    ...extra,
  };
}

// The live estate: lon-a single manager, two public workers, a NAT'd Lima VM.
const lonA = node('lon-a', { role: 'manager', leader: true, addr: '203.0.113.10', labels: { 'swarmy.region': 'lon' } });
const lonB = node('lon-b', { addr: '203.0.113.11' }, { meshIp: '100.92.0.11', meshConnected: true });
const nyc = node('nyc-a', { addr: '198.51.100.5' });

describe('isMeshCidr / isOnMesh', () => {
  it('recognises CGNAT 100.64/10 and nothing else', () => {
    expect(isMeshCidr('100.64.0.1')).toBe(true);
    expect(isMeshCidr('100.127.255.254')).toBe(true);
    expect(isMeshCidr('100.128.0.1')).toBe(false);
    expect(isMeshCidr('10.0.0.1')).toBe(false);
    expect(isMeshCidr(undefined)).toBe(false);
  });
  it('matches the peer mesh IP, ignoring a port', () => {
    expect(isOnMesh('10.9.9.9:2377', '10.9.9.9')).toBe(true);
    expect(isOnMesh('203.0.113.1', '100.92.0.1')).toBe(false);
  });
});

describe('planMeshMigration — onto the mesh', () => {
  const plan = planMeshMigration({ direction: 'onto-mesh', nodes: [nyc, lonA, lonB], services: [] });

  it('single manager: never moved, only enrolled — and surfaced as a public-address note', () => {
    expect(plan.managersStay).toBe(true);
    const m = plan.nodes.find((n) => n.nodeId === 'lon-a')!;
    expect(m.action).toBe('enroll-only');
    expect(m.reason).toContain('stays on its public address');
    expect(plan.warnings.some((w) => w.includes('lon-a stays on its address 203.0.113.10'))).toBe(true);
  });

  it('enrolls the manager FIRST, then moves workers one at a time in input order', () => {
    expect(plan.nodes.map((n) => [n.nodeId, n.action])).toEqual([
      ['lon-a', 'enroll-only'],
      ['nyc-a', 'move'],
      ['lon-b', 'move'],
    ]);
    expect(plan.blockers).toEqual([]);
  });

  it('an already-enrolled single manager just stays put', () => {
    const p = planMeshMigration({
      direction: 'onto-mesh',
      nodes: [{ ...lonA, meshConnected: true, meshIp: '100.92.0.10' }],
      services: [],
    });
    expect(p.nodes[0]!.action).toBe('stays-put');
  });

  it('a worker already advertising its mesh IP is skipped', () => {
    const lima = node('lima', { addr: '100.92.0.40' }, { meshIp: '100.92.0.40', meshConnected: true });
    const p = planMeshMigration({ direction: 'onto-mesh', nodes: [lonA, lima], services: [] });
    expect(p.nodes.find((n) => n.nodeId === 'lima')!.action).toBe('already');
  });

  it('two managers still stay (no quorum margin for a demote)', () => {
    const m2 = node('lon-c', { role: 'manager' });
    const p = planMeshMigration({ direction: 'onto-mesh', nodes: [lonA, m2, nyc], services: [] });
    expect(p.managersStay).toBe(true);
    expect(p.nodes.filter((n) => n.kind === 'manager').every((n) => n.action !== 'move')).toBe(true);
  });

  it('≥3 managers: they move after workers, followers first, leader last', () => {
    const m1 = node('m1', { role: 'manager', leader: true });
    const m2 = node('m2', { role: 'manager' });
    const m3 = node('m3', { role: 'manager' });
    const w = node('w1');
    const p = planMeshMigration({ direction: 'onto-mesh', nodes: [m1, m2, w, m3], services: [] });
    expect(p.managersStay).toBe(false);
    expect(p.nodes.map((n) => n.nodeId)).toEqual(['w1', 'm2', 'm3', 'm1']);
    expect(p.nodes.every((n) => n.action === 'move')).toBe(true);
  });

  it('the controller host moves last within its tier, with a warning', () => {
    const ctl = node('ctl', {}, { hostsController: true });
    const p = planMeshMigration({ direction: 'onto-mesh', nodes: [lonA, ctl, nyc], services: [] });
    expect(p.nodes.map((n) => n.nodeId)).toEqual(['lon-a', 'nyc-a', 'ctl']);
    expect(p.warnings.some((w) => w.includes('ctl runs the swarmy controller'))).toBe(true);
  });

  it('blocks on an offline node or one that has not reported', () => {
    const off = node('off', {}, { online: false });
    const unreported: PlanNodeInput = { nodeId: 'ghost', hostname: 'ghost', online: true, meshConnected: false };
    const p = planMeshMigration({ direction: 'onto-mesh', nodes: [lonA, off, unreported], services: [] });
    expect(p.blockers).toHaveLength(2);
    expect(p.blockers.join(' ')).toContain('off is offline');
    expect(p.blockers.join(' ')).toContain('ghost');
  });

  it('warns about data members pinned to a moving node', () => {
    const p = planMeshMigration({
      direction: 'onto-mesh',
      nodes: [lonA, nyc],
      services: [
        { name: 'app_db', labels: { 'swarmy.db.node': 'sw-nyc-a' } },
        { name: 'app_cache', labels: { 'swarmy.cache.node': 'sw-lon-a' } }, // manager stays → no warning
      ],
    });
    expect(p.nodes.find((n) => n.nodeId === 'nyc-a')!.pinned).toEqual(['app_db']);
    const pinWarnings = p.warnings.filter((w) => w.includes('is pinned to'));
    expect(pinWarnings).toHaveLength(1);
    expect(pinWarnings[0]).toContain('app_db is pinned to nyc-a');
  });

  it('warns when the node is the last schedulable one', () => {
    const drained = node('d', { role: 'manager', availability: 'drain' });
    const p = planMeshMigration({ direction: 'onto-mesh', nodes: [drained, nyc], services: [] });
    expect(p.warnings.some((w) => w.includes('nyc-a is the only schedulable node'))).toBe(true);
  });
});

describe('planMeshMigration — reverse (off the mesh)', () => {
  const meshW = node('lon-b', { addr: '100.92.0.11' }, { meshIp: '100.92.0.11', meshConnected: true });
  const pubW = node('nyc-a', { addr: '198.51.100.5' });

  it('moves only nodes advertising on the mesh; the single manager stays', () => {
    const p = planMeshMigration({ direction: 'off-mesh', nodes: [lonA, meshW, pubW], services: [] });
    expect(p.nodes.map((n) => [n.nodeId, n.action])).toEqual([
      ['lon-a', 'stays-put'],
      ['lon-b', 'move'],
      ['nyc-a', 'already'],
    ]);
    expect(p.nodes.find((n) => n.nodeId === 'lon-b')!.reason).toContain('its own address');
  });

  it('warns when a moving node has no public address (NAT’d)', () => {
    const p = planMeshMigration({ direction: 'off-mesh', nodes: [lonA, meshW], services: [] });
    expect(p.warnings.some((w) => w.includes('lon-b reported no public address'))).toBe(true);
    const withIp = node('lon-b', { addr: '100.92.0.11', labels: { 'swarmy.node.public-ip': '203.0.113.11' } });
    const q = planMeshMigration({ direction: 'off-mesh', nodes: [lonA, withIp], services: [] });
    expect(q.warnings.some((w) => w.includes('no public address'))).toBe(false);
  });

  it('flags a lone manager that itself advertises on the mesh', () => {
    const meshMgr = node('m', { role: 'manager', addr: '100.92.0.1' }, { meshIp: '100.92.0.1', meshConnected: true });
    const p = planMeshMigration({ direction: 'off-mesh', nodes: [meshMgr], services: [] });
    expect(p.nodes[0]!.action).toBe('stays-put');
    expect(p.nodes[0]!.onMesh).toBe(true);
    expect(p.warnings.some((w) => w.includes('mesh must stay on'))).toBe(true);
  });
});

describe('label snapshot / restore', () => {
  const info = swarm({
    swarmNodeId: 'old',
    hostname: 'nyc-a',
    addr: '198.51.100.5:2377',
    availability: 'active',
    labels: {
      'swarmy.region': 'nyc',
      'swarmy.node.ingress': 'true',
      'swarmy.node.outlet': '',
      'swarmy.node.public-ip': '198.51.100.5',
    },
  });

  it('captures id, role, availability, every label, and the bare addr', () => {
    const snap = snapshotNodeSpec(info);
    expect(snap).toEqual({
      swarmNodeId: 'old',
      role: 'worker',
      availability: 'active',
      labels: info.labels,
      addr: '198.51.100.5',
    });
    // A copy — later mutation of the live info can't corrupt the snapshot.
    info.labels['swarmy.region'] = 'mutated';
    expect(snap.labels['swarmy.region']).toBe('nyc');
    info.labels['swarmy.region'] = 'nyc';
  });

  it('restores everything onto a blank rejoined node — including "role off" empty strings', () => {
    const snap = snapshotNodeSpec(info);
    expect(labelsToRestore(snap, {})).toEqual(info.labels);
    expect(labelsToRestore(snap, undefined)).toEqual(info.labels);
  });

  it('only writes what differs (idempotent resume)', () => {
    const snap = snapshotNodeSpec(info);
    expect(labelsToRestore(snap, { ...info.labels })).toEqual({});
    expect(labelsToRestore(snap, { ...info.labels, 'swarmy.region': 'x' })).toEqual({ 'swarmy.region': 'nyc' });
  });
});

describe('pin remap — the swarm node id changes on rejoin', () => {
  const services: PlanServiceInput[] = [
    { name: 'app_db', labels: { 'swarmy.db.node': 'old', 'swarmy.managed': 'true' } },
    { name: 'app_cache', labels: { 'swarmy.cache.node': 'old' } },
    { name: 'app_cache_replica', labels: { 'swarmy.cache.avoidNode': 'old' } },
    { name: 'otel_clickhouse', labels: { 'swarmy.observability.node': 'old' } },
    { name: 'elsewhere', labels: { 'swarmy.db.node': 'other' } },
    { name: 'unrelated', labels: { 'note': 'old' } },
  ];

  it('re-points every node-pin label that carries the OLD id, and nothing else', () => {
    expect(planPinRemap(services, 'old', 'new')).toEqual([
      { service: 'app_cache', setLabels: { 'swarmy.cache.node': 'new' } },
      { service: 'app_cache_replica', setLabels: { 'swarmy.cache.avoidNode': 'new' } },
      { service: 'app_db', setLabels: { 'swarmy.db.node': 'new' } },
      { service: 'otel_clickhouse', setLabels: { 'swarmy.observability.node': 'new' } },
    ]);
  });

  it('is a no-op when the id did not change', () => {
    expect(planPinRemap(services, 'old', 'old')).toEqual([]);
    expect(planPinRemap(services, '', 'new')).toEqual([]);
  });

  it('rewrites node.id==/!= constraints for the old id only', () => {
    expect(
      remapConstraints(['node.id==old', 'node.id != old', 'node.id==other', 'node.labels.swarmy.region==nyc'], 'old', 'new'),
    ).toEqual(['node.id==new', 'node.id != new', 'node.id==other', 'node.labels.swarmy.region==nyc']);
    expect(remapConstraints(undefined, 'old', 'new')).toBeUndefined();
  });
});
