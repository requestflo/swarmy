import type {
  CacheBackupView,
  CacheClusterView,
  CacheMemberView,
  CacheProvisionResult,
  CacheStatsView,
  CacheTopology,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Managed-cache demo resolvers — the Caches surface (`/data/cache`): cluster
 * list/detail, live-ish stats, attach/detach, tuning, snapshots and destroy.
 * Return shapes mirror `cache.service.ts` views exactly (imported from
 * @swarmy/core, never redeclared). State lives in `store.extra.cache`;
 * mutations rewrite it so the page reflects changes after invalidation.
 */

interface CacheState {
  clusters: CacheClusterView[];
  /** `<stack>/<cluster>` → snapshots (newest first). */
  backups: Record<string, CacheBackupView[]>;
}

function getState(store: DemoStore): CacheState {
  return store.extra.cache as CacheState;
}

const key = (stack: string, cluster: string): string => `${stack}/${cluster}`;
const nowIso = (): string => new Date().toISOString();
const MB = 1024 * 1024;

function find(st: CacheState, i: unknown): CacheClusterView | undefined {
  const { stack, cluster } = i as { stack: string; cluster: string };
  return st.clusters.find((c) => c.stack === stack && c.name === cluster);
}

function require_(st: CacheState, i: unknown): CacheClusterView {
  const c = find(st, i);
  if (!c) throw new Error('cache cluster not found');
  return c;
}

/** Wobble the seeded stats so polls feel alive. */
function liveStats(c: CacheClusterView): CacheStatsView {
  const base = c.stats ?? {
    usedMemoryBytes: Math.round(c.memoryMb * MB * 0.4),
    maxMemoryBytes: c.memoryMb * MB,
    connectedClients: 8,
    opsPerSec: 200,
    keys: 10_000,
    hitRatePct: 95,
    at: nowIso(),
  };
  const wob = (n: number, pct: number): number =>
    Math.max(0, Math.round(n * (1 + (Math.random() * 2 - 1) * pct)));
  const next: CacheStatsView = {
    usedMemoryBytes: Math.min(wob(base.usedMemoryBytes, 0.03), c.memoryMb * MB),
    maxMemoryBytes: c.memoryMb * MB,
    connectedClients: wob(base.connectedClients, 0.2),
    opsPerSec: wob(base.opsPerSec, 0.25),
    keys: wob(base.keys, 0.01),
    hitRatePct: base.hitRatePct,
    at: nowIso(),
  };
  c.stats = next;
  return next;
}

function members(
  stack: string,
  name: string,
  topology: CacheTopology,
  replicas: number,
): CacheMemberView[] {
  const base = `${stack}_${name}-cache`;
  const out: CacheMemberView[] = [
    { service: base, role: 'primary', status: 'running', desired: 1, running: 1 },
  ];
  if (topology !== 'single' && replicas > 0) {
    out.push({
      service: `${base}-replica`,
      role: 'replica',
      status: 'running',
      desired: replicas,
      running: replicas,
    });
  }
  if (topology === 'sentinel') {
    out.push({
      service: `${base}-sentinel`,
      role: 'sentinel',
      status: 'running',
      desired: 3,
      running: 3,
    });
  }
  return out.sort((a, b) => a.service.localeCompare(b.service));
}

function makeCluster(input: {
  stack: string;
  name: string;
  engine: 'valkey' | 'redis';
  topology: CacheTopology;
  memoryMb: number;
  replicas: number;
}): CacheClusterView {
  const replicas = input.topology === 'sentinel' ? Math.max(1, input.replicas) : input.replicas;
  return {
    stack: input.stack,
    name: input.name,
    engine: input.engine,
    topology: input.topology,
    memoryMb: input.memoryMb,
    declaredReplicas: input.topology === 'single' ? 0 : replicas,
    primary: { service: `${input.stack}_${input.name}-cache`, status: 'running' },
    replicas:
      input.topology === 'single'
        ? { desired: 0, running: 0 }
        : { desired: replicas, running: replicas },
    sentinels: input.topology === 'sentinel' ? { desired: 3, running: 3 } : { desired: 0, running: 0 },
    host: `${input.stack}_${input.name}-cache`,
    port: 6379,
    passwordSecret: `swarmy-cache-${input.stack}_${input.name}-password`,
    members: members(input.stack, input.name, input.topology, replicas),
    stats: null,
    attachments: [],
  };
}

export const cache: DomainResolvers = {
  seed: (store) => {
    // One HA valkey cluster with plausible traffic, wired to the storefront app.
    const main = makeCluster({
      stack: 'storefront',
      name: 'main',
      engine: 'valkey',
      topology: 'sentinel',
      memoryMb: 512,
      replicas: 2,
    });
    main.stats = {
      usedMemoryBytes: 214 * MB,
      maxMemoryBytes: 512 * MB,
      connectedClients: 23,
      opsPerSec: 1_840,
      keys: 48_211,
      hitRatePct: 97.4,
      at: nowIso(),
    };
    main.attachments = [
      { service: 'web', envVar: 'REDIS_URL' },
      { service: 'api', envVar: 'REDIS_URL' },
    ];

    const sessions = makeCluster({
      stack: 'platform',
      name: 'sessions',
      engine: 'redis',
      topology: 'single',
      memoryMb: 128,
      replicas: 0,
    });
    sessions.stats = {
      usedMemoryBytes: 41 * MB,
      maxMemoryBytes: 128 * MB,
      connectedClients: 4,
      opsPerSec: 96,
      keys: 3_412,
      hitRatePct: 88.1,
      at: nowIso(),
    };

    store.extra.cache = {
      clusters: [main, sessions],
      backups: {
        'storefront/main': [
          {
            id: 'a1b2c3d4e5f60718',
            time: new Date(Date.now() - 7 * 3_600_000).toISOString(),
            sizeBytes: String(198 * MB),
            tags: ['org:demo', 'volume:storefront_main-cache-data', 'cache:storefront_main'],
          },
          {
            id: '99f8e7d6c5b4a392',
            time: new Date(Date.now() - 31 * 3_600_000).toISOString(),
            sizeBytes: String(187 * MB),
            tags: ['org:demo', 'volume:storefront_main-cache-data', 'cache:storefront_main'],
          },
        ],
      },
    } satisfies CacheState;
  },

  handlers: {
    'cache.list': (_i, s): CacheClusterView[] =>
      [...getState(s).clusters].sort((a, b) =>
        key(a.stack, a.name).localeCompare(key(b.stack, b.name)),
      ),

    'cache.get': (i, s): CacheClusterView => require_(getState(s), i),

    'cache.stats': (i, s): CacheStatsView => liveStats(require_(getState(s), i)),

    'cache.provision': (i, s): CacheProvisionResult => {
      const b = i as {
        stack: string;
        name: string;
        engine?: 'valkey' | 'redis';
        topology?: CacheTopology;
        memoryMb?: number;
        replicas?: number;
        attachService?: string;
      };
      const st = getState(s);
      const c = makeCluster({
        stack: b.stack,
        name: b.name,
        engine: b.engine ?? 'valkey',
        topology: b.topology ?? 'single',
        memoryMb: b.memoryMb ?? 256,
        replicas: b.replicas ?? 0,
      });
      if (b.attachService) c.attachments = [{ service: b.attachService, envVar: 'REDIS_URL' }];
      st.clusters = [...st.clusters, c];
      return {
        stack: c.stack,
        cluster: c.name,
        engine: c.engine,
        topology: c.topology,
        host: c.host,
        port: c.port,
        passwordSecret: c.passwordSecret,
        password: 'demo-o5Yw2kQhV7pXbC1rTzUj9NmA',
      };
    },

    'cache.setReplicas': (i, s): { cluster: string; replicas: number } => {
      const { replicas } = i as { replicas: number };
      const c = require_(getState(s), i);
      const n = c.topology === 'sentinel' ? Math.max(1, replicas) : Math.max(0, replicas);
      c.declaredReplicas = n;
      c.replicas = { desired: n, running: n };
      c.members = members(c.stack, c.name, c.topology, n);
      return { cluster: c.name, replicas: n };
    },

    'cache.setMemory': (i, s): { cluster: string; memoryMb: number } => {
      const { memoryMb } = i as { memoryMb: number };
      const c = require_(getState(s), i);
      c.memoryMb = memoryMb;
      if (c.stats) c.stats = { ...c.stats, maxMemoryBytes: memoryMb * MB };
      return { cluster: c.name, memoryMb };
    },

    'cache.destroy': (i, s): { cluster: string; removed: true } => {
      const st = getState(s);
      const c = require_(st, i);
      st.clusters = st.clusters.filter((x) => x !== c);
      delete st.backups[key(c.stack, c.name)];
      return { cluster: c.name, removed: true };
    },

    'cache.attachToService': (
      i,
      s,
    ): { appService: string; cluster: string; envVar: string; url: string; passwordFileVar: string } => {
      const b = i as { appService: string; envVar?: string };
      const c = require_(getState(s), i);
      const envVar = b.envVar ?? 'REDIS_URL';
      if (!c.attachments.some((a) => a.service === b.appService)) {
        c.attachments = [...c.attachments, { service: b.appService, envVar }];
      }
      return {
        appService: b.appService,
        cluster: c.name,
        envVar,
        url: `redis://${c.host}:${c.port}`,
        passwordFileVar: envVar.endsWith('_URL')
          ? `${envVar.slice(0, -4)}_PASSWORD_FILE`
          : `${envVar}_PASSWORD_FILE`,
      };
    },

    'cache.detach': (i, s): { appService: string; cluster: string; detached: true } => {
      const { appService } = i as { appService: string };
      const c = require_(getState(s), i);
      c.attachments = c.attachments.filter((a) => a.service !== appService);
      return { appService, cluster: c.name, detached: true };
    },

    'cache.backup': (i, s): { resticId: string; sizeBytes: string } => {
      const st = getState(s);
      const c = require_(st, i);
      const id = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      const sizeBytes = String(c.stats?.usedMemoryBytes ?? 64 * MB);
      const row: CacheBackupView = {
        id,
        time: nowIso(),
        sizeBytes,
        tags: [`volume:${c.stack}_${c.name}-cache-data`, `cache:${c.stack}_${c.name}`],
      };
      const k = key(c.stack, c.name);
      st.backups[k] = [row, ...(st.backups[k] ?? [])];
      return { resticId: id, sizeBytes };
    },

    'cache.restore': (i, s): { cluster: string; bytesRestored: string } => {
      const st = getState(s);
      const c = require_(st, i);
      const { snapshotId } = i as { snapshotId: string };
      const snap = (st.backups[key(c.stack, c.name)] ?? []).find((b) => b.id === snapshotId);
      return { cluster: c.name, bytesRestored: snap?.sizeBytes ?? '0' };
    },

    'cache.listBackups': (i, s): CacheBackupView[] => {
      const st = getState(s);
      const c = require_(st, i);
      return st.backups[key(c.stack, c.name)] ?? [];
    },
  },
};
