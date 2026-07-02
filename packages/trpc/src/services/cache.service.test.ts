import { describe, expect, it } from 'bun:test';
import {
  cachePasswordFileVar,
  cachePasswordSecretName,
  cachePrimarySpec,
  cacheRegionReplicaSpec,
  cacheReplicaSpec,
  cacheSentinelSpec,
  encodeStatsLabel,
  memoryLimitBytes,
  parseCacheInfo,
  parseCacheRegionReplicas,
  parseStatsLabel,
  planCacheConvergence,
  SENTINEL_COUNT,
  type CacheDeclaredState,
  type CacheLiveState,
} from './cache.service';

const INFO = [
  '# Server',
  'redis_version:7.4.1',
  '',
  '# Clients',
  'connected_clients:12',
  '',
  '# Memory',
  'used_memory:104857600',
  'used_memory_human:100.00M',
  'maxmemory:268435456',
  '',
  '# Stats',
  'instantaneous_ops_per_sec:341',
  'keyspace_hits:900',
  'keyspace_misses:100',
  '',
  '# Keyspace',
  'db0:keys=1500,expires=200,avg_ttl=0',
  'db2:keys=500,expires=0,avg_ttl=0',
].join('\r\n');

describe('parseCacheInfo — INFO dump → stats sample', () => {
  it('parses memory, clients, ops, keyspace and hit rate', () => {
    const s = parseCacheInfo(INFO);
    expect(s).toEqual({
      usedMemoryBytes: 104857600,
      maxMemoryBytes: 268435456,
      connectedClients: 12,
      opsPerSec: 341,
      keys: 2000,
      hitRatePct: 90,
    });
  });

  it('returns null hit rate before any lookups', () => {
    const s = parseCacheInfo('used_memory:10\nkeyspace_hits:0\nkeyspace_misses:0');
    expect(s?.hitRatePct).toBeNull();
  });

  it('tolerates missing fields (zeros) and empty keyspace', () => {
    const s = parseCacheInfo('used_memory:42');
    expect(s).toEqual({
      usedMemoryBytes: 42,
      maxMemoryBytes: 0,
      connectedClients: 0,
      opsPerSec: 0,
      keys: 0,
      hitRatePct: null,
    });
  });

  it('rejects non-INFO payloads', () => {
    expect(parseCacheInfo('NOAUTH Authentication required.')).toBeNull();
    expect(parseCacheInfo('')).toBeNull();
  });
});

describe('stats label codec', () => {
  it('round-trips through the label', () => {
    const stats = {
      usedMemoryBytes: 1024,
      maxMemoryBytes: 4096,
      connectedClients: 3,
      opsPerSec: 17,
      keys: 42,
      hitRatePct: 99.5,
      at: '2026-07-02T10:00:00.000Z',
    };
    expect(parseStatsLabel(encodeStatsLabel(stats))).toEqual(stats);
  });

  it('degrades malformed/foreign labels to null', () => {
    expect(parseStatsLabel(undefined)).toBeNull();
    expect(parseStatsLabel('not json')).toBeNull();
    expect(parseStatsLabel('{"foo":1}')).toBeNull();
  });
});

const decl = (over: Partial<CacheDeclaredState> = {}): CacheDeclaredState => ({
  topology: 'replica',
  replicas: 2,
  memoryMb: 256,
  regionReplicas: {},
  ...over,
});
const member = (name: string, desired: number, appliedMemoryMb: number | null = 256) => ({
  name,
  desired,
  appliedMemoryMb,
});

describe('planCacheConvergence — topology diff planner', () => {
  it('is a no-op when live matches declared', () => {
    const live: CacheLiveState = {
      primary: member('s_c-cache', 1),
      replica: member('s_c-cache-replica', 2),
      regionReplicas: {},
    };
    expect(planCacheConvergence(decl(), live)).toEqual([]);
  });

  it('deploys the missing replica service', () => {
    const live: CacheLiveState = { primary: member('p', 1), regionReplicas: {} };
    expect(planCacheConvergence(decl(), live)).toEqual([{ kind: 'deploy-replica', replicas: 2 }]);
  });

  it('scales a drifted replica service', () => {
    const live: CacheLiveState = {
      primary: member('p', 1),
      replica: member('r', 5),
      regionReplicas: {},
    };
    expect(planCacheConvergence(decl(), live)).toEqual([
      { kind: 'scale', service: 'r', replicas: 2 },
    ]);
  });

  it('parks the replica at 0 under single and removes sentinels', () => {
    const live: CacheLiveState = {
      primary: member('p', 1),
      replica: member('r', 2),
      sentinel: member('sen', 3, null),
      regionReplicas: {},
    };
    expect(planCacheConvergence(decl({ topology: 'single', replicas: 2 }), live)).toEqual([
      { kind: 'scale', service: 'r', replicas: 0 },
      { kind: 'remove', service: 'sen' },
    ]);
  });

  it('sentinel topology: deploys the trio and holds a replica floor of 1', () => {
    const live: CacheLiveState = { primary: member('p', 1), regionReplicas: {} };
    expect(planCacheConvergence(decl({ topology: 'sentinel', replicas: 0 }), live)).toEqual([
      { kind: 'deploy-replica', replicas: 1 },
      { kind: 'deploy-sentinel' },
    ]);
  });

  it('rescales a drifted sentinel trio', () => {
    const live: CacheLiveState = {
      primary: member('p', 1),
      replica: member('r', 1),
      sentinel: member('sen', 1, null),
      regionReplicas: {},
    };
    expect(planCacheConvergence(decl({ topology: 'sentinel', replicas: 1 }), live)).toEqual([
      { kind: 'scale', service: 'sen', replicas: SENTINEL_COUNT },
    ]);
  });

  it('creates / scales / removes region-pinned siblings', () => {
    const live: CacheLiveState = {
      primary: member('p', 1),
      replica: member('r', 2),
      regionReplicas: {
        'eu-west': member('r-eu-west', 1),
        'ap-south': member('r-ap-south', 2),
      },
    };
    const actions = planCacheConvergence(
      decl({ regionReplicas: { 'eu-west': 3, 'us-east': 1 } }),
      live,
    );
    expect(actions).toContainEqual({ kind: 'scale', service: 'r-eu-west', replicas: 3 });
    expect(actions).toContainEqual({ kind: 'deploy-region-replica', region: 'us-east', replicas: 1 });
    expect(actions).toContainEqual({ kind: 'remove', service: 'r-ap-south' });
    expect(actions).toHaveLength(3);
  });

  it('flags memory drift on data members only', () => {
    const live: CacheLiveState = {
      primary: member('p', 1, 128),
      replica: member('r', 2, 256),
      sentinel: member('sen', 3, null),
      regionReplicas: {},
    };
    expect(planCacheConvergence(decl({ topology: 'sentinel', replicas: 2 }), live)).toEqual([
      { kind: 'redeploy-memory', service: 'p' },
    ]);
  });
});

describe('label + naming codecs', () => {
  it('parses per-region replica labels and ignores junk', () => {
    expect(
      parseCacheRegionReplicas({
        'swarmy.cache.region.eu-west.replicas': '2',
        'swarmy.cache.region.us-east.replicas': '0',
        'swarmy.cache.region..replicas': '3',
        'swarmy.cache.region.bad.replicas': '-1',
        'swarmy.cache.engine': 'valkey',
      }),
    ).toEqual({ 'eu-west': 2, 'us-east': 0 });
  });

  it('derives the password-file companion var', () => {
    expect(cachePasswordFileVar('REDIS_URL')).toBe('REDIS_PASSWORD_FILE');
    expect(cachePasswordFileVar('CACHE')).toBe('CACHE_PASSWORD_FILE');
  });

  it('stack-qualifies the password secret name', () => {
    expect(cachePasswordSecretName('shop', 'main')).toBe('swarmy-cache-shop_main-password');
  });

  it('adds headroom to the swarm memory limit', () => {
    expect(memoryLimitBytes(256)).toBe(320 * 1024 * 1024);
  });
});

describe('spec builders — private-only, secret-fed, memory-capped', () => {
  const d = {
    stack: 'shop',
    cluster: 'main',
    engine: 'valkey' as const,
    topology: 'sentinel' as const,
    memoryMb: 256,
    replicas: 2,
    regionReplicas: { 'eu-west': 1 },
  };

  it('never publishes ports on any member', () => {
    for (const spec of [
      cachePrimarySpec(d),
      cacheReplicaSpec(d, 2),
      cacheSentinelSpec(d),
      cacheRegionReplicaSpec(d, 'eu-west', 1),
    ]) {
      expect(spec.ports).toBeUndefined();
    }
  });

  it('valkey reads the password from the secret file, never env/labels', () => {
    const spec = cachePrimarySpec(d);
    expect(spec.secrets).toEqual([
      { source: 'swarmy-cache-shop_main-password', target: 'cache-password' },
    ]);
    expect(spec.args?.[0]).toContain('$(cat /run/secrets/cache-password)');
    expect(spec.args?.[0]).toContain('--maxmemory 256mb');
    expect(JSON.stringify(spec.labels)).not.toContain('password');
    expect(spec.resources?.limits?.memoryBytes).toBe(memoryLimitBytes(256));
  });

  it('bitnami redis members use *_PASSWORD_FILE env', () => {
    const spec = cacheReplicaSpec({ ...d, engine: 'redis' }, 2);
    expect(spec.env?.REDIS_PASSWORD_FILE).toBe('/run/secrets/cache-password');
    expect(spec.env?.REDIS_MASTER_HOST).toBe('shop_main-cache');
    expect(spec.env?.REDIS_REPLICATION_MODE).toBe('slave');
  });

  it('sentinel trio: 3 members, quorum 2, master set = cluster name', () => {
    const spec = cacheSentinelSpec(d);
    expect(spec.mode).toEqual({ replicated: { replicas: 3 } });
    expect(spec.env?.REDIS_SENTINEL_QUORUM).toBe('2');
    expect(spec.env?.REDIS_MASTER_SET).toBe('main');
    expect(spec.labels?.['swarmy.cache.role']).toBe('sentinel');
  });

  it('region siblings are pinned to the region node label', () => {
    const spec = cacheRegionReplicaSpec(d, 'eu-west', 1);
    expect(spec.placement?.constraints).toEqual(['node.labels.swarmy.region==eu-west']);
    expect(spec.labels?.['swarmy.cache.region']).toBe('eu-west');
  });

  it('primary carries the data volume + region replica declarations', () => {
    const spec = cachePrimarySpec(d);
    expect(spec.mounts).toEqual([
      { type: 'volume', source: 'shop_main-cache-data', target: '/data' },
    ]);
    expect(spec.labels?.['swarmy.cache.region.eu-west.replicas']).toBe('1');
  });
});
