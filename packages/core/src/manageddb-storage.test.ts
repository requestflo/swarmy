import { describe, expect, it } from 'bun:test';
import {
  BITNAMI_PG_ROOT,
  DB_AVOID_NODE_LABEL,
  DB_DATA_VOLUME_LABEL,
  DB_PIN_NODE_LABEL,
  applyDbStorage,
  choosePinNode,
  dbStorageState,
  pinnedPrimaryCounts,
  primaryDataVolumeName,
  replicaDataVolumeName,
  storageMigrateScript,
  type StorageSpecLike,
} from './manageddb-storage';
import { SwarmServiceInfo, ContainerInfo } from './protocol';

describe('managed-DB volume names', () => {
  it('derives <stack>_<cluster>-{primary,replica}-data', () => {
    expect(primaryDataVolumeName('hello', 'main')).toBe('hello_main-primary-data');
    expect(replicaDataVolumeName('hello', 'main')).toBe('hello_main-replica-data');
  });
});

describe('applyDbStorage — never rebuild a bare spec', () => {
  it('re-derives the primary mount + node pin from labels, keeping other mounts/constraints', () => {
    const out = applyDbStorage<StorageSpecLike>(
      {
        mounts: [
          { type: 'volume' as const, source: 'hello_main-wal-archive', target: '/wal-archive' },
          // a stale/foreign mount on the data path is replaced by the declared volume
          { type: 'volume' as const, source: 'something-else', target: BITNAMI_PG_ROOT },
        ],
        placement: { constraints: ['node.labels.swarmy.region==eu', 'node.id==stale'] },
      },
      { [DB_DATA_VOLUME_LABEL]: 'hello_main-primary-data', [DB_PIN_NODE_LABEL]: 'n1' },
    );
    expect(out.mounts).toEqual([
      { type: 'volume', source: 'hello_main-primary-data', target: BITNAMI_PG_ROOT },
      { type: 'volume', source: 'hello_main-wal-archive', target: '/wal-archive' },
    ]);
    expect(out.placement).toEqual({
      constraints: ['node.labels.swarmy.region==eu', 'node.id==n1'],
      maxReplicasPerNode: 1,
    });
  });

  it('replicas get anti-affinity + one task per node', () => {
    const out = applyDbStorage<StorageSpecLike>(
      {},
      { [DB_DATA_VOLUME_LABEL]: 'hello_main-replica-data', [DB_AVOID_NODE_LABEL]: 'n1' },
    );
    expect(out.placement).toEqual({ constraints: ['node.id!=n1'], maxReplicasPerNode: 1 });
  });

  it('is idempotent', () => {
    const labels = { [DB_DATA_VOLUME_LABEL]: 'v', [DB_PIN_NODE_LABEL]: 'n1' };
    const once = applyDbStorage<StorageSpecLike>({}, labels);
    expect(applyDbStorage(once, labels)).toEqual(once);
  });

  it('leaves a legacy (unlabelled) spec untouched', () => {
    const spec = { placement: { constraints: ['x==y'] } };
    expect(applyDbStorage<StorageSpecLike>(spec, {})).toBe(spec);
  });
});

describe('dbStorageState — legacy detection', () => {
  it('flags a live primary with no data mount as unmounted (the data-loss bug)', () => {
    const s = dbStorageState({ labels: { 'swarmy.db.role': 'primary' }, mounts: [] });
    expect(s.state).toBe('unmounted');
    expect(s.message).toContain('Migrate');
  });

  it('flags a labelled primary whose mount was dropped by a bare rebuild as unmounted', () => {
    const s = dbStorageState({ labels: { [DB_DATA_VOLUME_LABEL]: 'v' }, mounts: [] });
    expect(s.state).toBe('unmounted');
  });

  it('persistent when the declared volume is mounted', () => {
    expect(
      dbStorageState({
        labels: { [DB_DATA_VOLUME_LABEL]: 'v', [DB_PIN_NODE_LABEL]: 'n1' },
        mounts: [{ type: 'volume', source: 'v', target: BITNAMI_PG_ROOT }],
      }),
    ).toEqual({ state: 'persistent', dataVolume: 'v', pinnedNode: 'n1' });
  });

  it('marks a mounted-but-undeclared volume (pre-label PITR dataVolume) for adoption', () => {
    const s = dbStorageState({
      labels: {},
      mounts: [{ type: 'volume', source: 'pgdata', target: BITNAMI_PG_ROOT }],
    });
    expect(s).toEqual({ state: 'persistent', dataVolume: 'pgdata', undeclared: true });
  });

  it('an older agent (mounts undefined) is unknown, not a false alarm', () => {
    expect(dbStorageState({ labels: {} }).state).toBe('unknown');
    expect(dbStorageState({ labels: { [DB_DATA_VOLUME_LABEL]: 'v' } }).state).toBe('persistent');
  });
});

describe('choosePinNode', () => {
  const node = (id: string, role: 'manager' | 'worker' = 'worker', extra = {}) => ({
    swarmNodeId: id,
    role,
    availability: 'active' as const,
    status: 'ready' as const,
    ...extra,
  });

  it('prefers a node not already hosting a primary', () => {
    expect(
      choosePinNode({
        nodes: [node('m1', 'manager'), node('w1')],
        pinnedCounts: new Map([['m1', 1]]),
        fallback: 'm1',
      }),
    ).toBe('w1');
  });

  it('ties go to the fallback manager; drained/down nodes are skipped', () => {
    expect(
      choosePinNode({
        nodes: [node('a'), node('m1', 'manager'), node('d', 'worker', { availability: 'drain' })],
        pinnedCounts: new Map(),
        fallback: 'm1',
      }),
    ).toBe('m1');
  });

  it('falls back when there is no usable inventory', () => {
    expect(choosePinNode({ nodes: [], pinnedCounts: new Map(), fallback: 'm1' })).toBe('m1');
  });

  it('counts pinned primaries off labels', () => {
    const counts = pinnedPrimaryCounts([
      { labels: { 'swarmy.db.role': 'primary', [DB_PIN_NODE_LABEL]: 'n1' } },
      { labels: { 'swarmy.db.role': 'replica', [DB_PIN_NODE_LABEL]: 'n1' } },
      { labels: { 'swarmy.db.role': 'primary', [DB_PIN_NODE_LABEL]: 'n1' } },
    ]);
    expect(counts.get('n1')).toBe(2);
  });
});

describe('storageMigrateScript', () => {
  it('verifies the source, moves existing contents aside, never deletes the source', () => {
    const s = storageMigrateScript('123');
    expect(s).toContain('test -f /from/data/PG_VERSION');
    expect(s).toContain('.swarmy-premigrate-123');
    expect(s).toContain('cp -a /from/. /to/');
    expect(s).not.toMatch(/rm -rf? \/from/);
  });
});

describe('protocol: mounts on services/containers (round-trip)', () => {
  const svc = {
    id: 's',
    name: 'hello_main-primary',
    image: 'bitnamilegacy/postgresql:16',
    mode: 'replicated',
    runningReplicas: 1,
    createdAt: 1,
    updatedAt: 1,
    labels: {},
  };
  it('keeps mounts when reported and leaves them undefined for older agents', () => {
    const mounts = [{ type: 'volume', source: 'v', target: BITNAMI_PG_ROOT }];
    expect(SwarmServiceInfo.parse({ ...svc, mounts }).mounts).toEqual(mounts);
    expect(SwarmServiceInfo.parse(svc).mounts).toBeUndefined();
    const parsed = SwarmServiceInfo.parse(JSON.parse(JSON.stringify(SwarmServiceInfo.parse({ ...svc, mounts }))));
    expect(parsed.mounts).toEqual(mounts);
  });
  it('containers carry the (anonymous) volume name', () => {
    const c = ContainerInfo.parse({
      id: 'c',
      name: 'x',
      image: 'i',
      state: 'running',
      status: 'Up',
      createdAt: 1,
      ports: [],
      labels: {},
      mounts: [{ type: 'volume', source: 'a1b2c3', target: BITNAMI_PG_ROOT }],
    });
    expect(c.mounts?.[0]?.source).toBe('a1b2c3');
  });
});
