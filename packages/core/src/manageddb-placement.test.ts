import { describe, expect, it } from 'bun:test';
import {
  DB_ROLE_CONSTRAINT,
  DB_ROLE_PLACED_LABEL,
  databaseRoleServers,
  dbFloatingPlacement,
  dbRolePlacementLabels,
  rolePlacementOutgrown,
} from './manageddb-placement';
import { choosePinNode } from './manageddb-storage';

const node = (id: string, labels: Record<string, string> = {}, extra: Record<string, string> = {}) => ({
  swarmNodeId: id,
  role: 'worker' as const,
  status: 'ready' as const,
  availability: 'active' as const,
  labels,
  ...extra,
});
const DB = { 'swarmy.node.database': 'true' };
const inRegion = (r: string, more: Record<string, string> = {}) => ({ 'swarmy.region': r, ...more });

describe('dbFloatingPlacement — replicas prefer database-role servers, fall back as today', () => {
  it('constrains to the role when enough role servers can take every task', () => {
    const nodes = [node('a', DB), node('b', DB), node('c')];
    expect(dbFloatingPlacement({ nodes, replicas: 2 })).toEqual({ constraints: [DB_ROLE_CONSTRAINT], onRole: true });
    expect(DB_ROLE_CONSTRAINT).toBe('node.labels.swarmy.node.database==true');
  });

  it('falls back to no constraint when role servers are too few for the tasks', () => {
    const nodes = [node('a', DB), node('b'), node('c')];
    expect(dbFloatingPlacement({ nodes, replicas: 2 })).toEqual({ constraints: [], onRole: false });
  });

  it('never counts the avoided server (the primary pin), a drained or a down server', () => {
    const nodes = [
      node('pin', DB),
      node('drained', DB, { availability: 'drain' }),
      node('down', DB, { status: 'down' }),
      node('ok', DB),
    ];
    expect(databaseRoleServers({ nodes, replicas: 1, avoidNode: 'pin' })).toEqual(['ok']);
    expect(dbFloatingPlacement({ nodes, replicas: 2, avoidNode: 'pin' }).onRole).toBe(false);
    expect(dbFloatingPlacement({ nodes, replicas: 1, avoidNode: 'pin' }).onRole).toBe(true);
  });

  it('within a region: role servers of THAT region only, region constraint always kept', () => {
    const nodes = [node('eu-1', inRegion('eu', DB)), node('eu-2', inRegion('eu')), node('us-1', inRegion('us', DB))];
    expect(dbFloatingPlacement({ nodes, region: 'eu', replicas: 1 })).toEqual({
      constraints: ['node.labels.swarmy.region==eu', DB_ROLE_CONSTRAINT],
      onRole: true,
    });
    // Two tasks, one eu role server → region only, exactly today's placement.
    expect(dbFloatingPlacement({ nodes, region: 'eu', replicas: 2 }).constraints).toEqual(['node.labels.swarmy.region==eu']);
    expect(dbFloatingPlacement({ nodes, region: 'ap', replicas: 1 }).constraints).toEqual(['node.labels.swarmy.region==ap']);
  });

  it('a role label other than "true" is not the role; no role servers ⇒ today', () => {
    expect(dbFloatingPlacement({ nodes: [node('a', { 'swarmy.node.database': '' })], replicas: 1 }).onRole).toBe(false);
    expect(dbFloatingPlacement({ nodes: [], replicas: 1 })).toEqual({ constraints: [], onRole: false });
  });

  it('a member parked at 0 tasks still needs one role server to be placed on the role', () => {
    expect(dbFloatingPlacement({ nodes: [node('a', DB)], replicas: 0 }).onRole).toBe(true);
    expect(dbFloatingPlacement({ nodes: [node('a')], replicas: 0 }).onRole).toBe(false);
  });
});

describe('role placement marker + outgrown check', () => {
  it('stamps the marker only when placed on the role', () => {
    expect(dbRolePlacementLabels({ x: '1' }, { constraints: [DB_ROLE_CONSTRAINT], onRole: true })).toEqual({
      x: '1',
      [DB_ROLE_PLACED_LABEL]: 'true',
    });
    expect(dbRolePlacementLabels({ [DB_ROLE_PLACED_LABEL]: 'true' }, { constraints: [], onRole: false })).toEqual({});
  });

  it('a role-placed member scaled past the role servers is outgrown; an unmarked one never is', () => {
    const nodes = [node('a', DB), node('b', DB)];
    const marked = { [DB_ROLE_PLACED_LABEL]: 'true' };
    expect(rolePlacementOutgrown(marked, { nodes, replicas: 2 })).toBe(false);
    expect(rolePlacementOutgrown(marked, { nodes, replicas: 3 })).toBe(true);
    expect(rolePlacementOutgrown({}, { nodes, replicas: 3 })).toBe(false);
    expect(rolePlacementOutgrown(marked, { nodes, replicas: 0 })).toBe(false);
  });
});

describe('choosePinNode preferLabel — a new primary lands on a database-role server first', () => {
  const disk = { 'swarmy.disk.default': 'vol1', 'swarmy.disk.vol1': '/var/lib/swarmy/disks/vol1' };

  it('prefers the role over a data disk, a lighter load and the fallback manager', () => {
    const nodes = [node('m1', disk), node('w1', DB)];
    const pinnedCounts = new Map([['w1', 3]]);
    expect(choosePinNode({ nodes, pinnedCounts, fallback: 'm1', preferLabel: 'swarmy.node.database' })).toBe('w1');
    // Without the preference, today's order (data disk first) is unchanged.
    expect(choosePinNode({ nodes, pinnedCounts, fallback: 'm1' })).toBe('m1');
  });

  it('among role servers the usual order applies; no role server ⇒ today', () => {
    const nodes = [node('a', DB), node('b', { ...DB, ...disk }), node('c', disk)];
    expect(choosePinNode({ nodes, pinnedCounts: new Map(), preferLabel: 'swarmy.node.database' })).toBe('b');
    const plain = [node('a'), node('c', disk)];
    expect(choosePinNode({ nodes: plain, pinnedCounts: new Map(), preferLabel: 'swarmy.node.database' })).toBe('c');
  });

  it('a drained role server is never chosen', () => {
    const nodes = [node('a', DB, { availability: 'drain' }), node('b')];
    expect(choosePinNode({ nodes, pinnedCounts: new Map(), preferLabel: 'swarmy.node.database' })).toBe('b');
  });
});
