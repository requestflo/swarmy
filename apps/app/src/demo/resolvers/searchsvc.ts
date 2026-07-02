import type {
  SearchBackupView,
  SearchEngine,
  SearchInstanceView,
  SearchProvisionResult,
  SearchStatsView,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Managed-search demo resolvers — the Search surface of Data services
 * (`/data/search`): instance list/detail, live-ish stats, attach/detach,
 * snapshots and destroy. Return shapes mirror `search.service.ts` views
 * exactly (imported from @swarmy/core, never redeclared). State lives in
 * `store.extra.searchsvc`; mutations rewrite it so the page reflects changes
 * after invalidation.
 */

interface SearchState {
  instances: SearchInstanceView[];
  /** `<stack>/<name>` → snapshots (newest first). */
  backups: Record<string, SearchBackupView[]>;
}

function getState(store: DemoStore): SearchState {
  return store.extra.searchsvc as SearchState;
}

const key = (stack: string, name: string): string => `${stack}/${name}`;
const nowIso = (): string => new Date().toISOString();
const MB = 1024 * 1024;

function find(st: SearchState, i: unknown): SearchInstanceView | undefined {
  const { stack, name } = i as { stack: string; name: string };
  return st.instances.find((x) => x.stack === stack && x.name === name);
}

function require_(st: SearchState, i: unknown): SearchInstanceView {
  const x = find(st, i);
  if (!x) throw new Error('search instance not found');
  return x;
}

/** Wobble the seeded stats so polls feel alive. */
function liveStats(v: SearchInstanceView): SearchStatsView {
  const base = v.stats ?? {
    docs: 12_000,
    indexes: 2,
    dbSizeBytes: v.engine === 'meilisearch' ? 160 * MB : null,
    memoryBytes: v.engine === 'typesense' ? 96 * MB : null,
    at: nowIso(),
  };
  const wob = (n: number, pct: number): number =>
    Math.max(0, Math.round(n * (1 + (Math.random() * 2 - 1) * pct)));
  const next: SearchStatsView = {
    docs: wob(base.docs, 0.005),
    indexes: base.indexes,
    dbSizeBytes: base.dbSizeBytes !== null ? wob(base.dbSizeBytes, 0.01) : null,
    memoryBytes: base.memoryBytes !== null ? wob(base.memoryBytes, 0.03) : null,
    at: nowIso(),
  };
  v.stats = next;
  return next;
}

function makeInstance(input: {
  stack: string;
  name: string;
  engine: SearchEngine;
}): SearchInstanceView {
  const service = `${input.stack}_${input.name}-search`;
  const port = input.engine === 'meilisearch' ? 7700 : 8108;
  return {
    stack: input.stack,
    name: input.name,
    engine: input.engine,
    service,
    status: 'running',
    desired: 1,
    running: 1,
    host: service,
    port,
    url: `http://${service}:${port}`,
    keySecret: `swarmy-search-${input.stack}_${input.name}-key`,
    stats: null,
    attachments: [],
  };
}

export const searchsvc: DomainResolvers = {
  seed: (store) => {
    // One meilisearch instance with plausible catalog traffic, wired to the
    // storefront web app.
    const main = makeInstance({ stack: 'storefront', name: 'main', engine: 'meilisearch' });
    main.stats = {
      docs: 48_211,
      indexes: 3,
      dbSizeBytes: 412 * MB,
      memoryBytes: null,
      at: nowIso(),
    };
    main.attachments = [{ service: 'web', envVar: 'MEILI_HOST' }];

    store.extra.searchsvc = {
      instances: [main],
      backups: {
        'storefront/main': [
          {
            id: 'c4d5e6f708192a3b',
            time: new Date(Date.now() - 9 * 3_600_000).toISOString(),
            sizeBytes: String(388 * MB),
            tags: ['org:demo', 'volume:storefront_main-search-data', 'search:storefront_main'],
          },
          {
            id: '7a8b9c0d1e2f3041',
            time: new Date(Date.now() - 33 * 3_600_000).toISOString(),
            sizeBytes: String(371 * MB),
            tags: ['org:demo', 'volume:storefront_main-search-data', 'search:storefront_main'],
          },
        ],
      },
    } satisfies SearchState;
  },

  handlers: {
    'search.list': (_i, s): SearchInstanceView[] =>
      [...getState(s).instances].sort((a, b) =>
        key(a.stack, a.name).localeCompare(key(b.stack, b.name)),
      ),

    'search.get': (i, s): SearchInstanceView => require_(getState(s), i),

    'search.stats': (i, s): SearchStatsView => liveStats(require_(getState(s), i)),

    'search.provision': (i, s): SearchProvisionResult => {
      const b = i as {
        stack: string;
        name: string;
        engine?: SearchEngine;
        attachService?: string;
      };
      const st = getState(s);
      const v = makeInstance({
        stack: b.stack,
        name: b.name,
        engine: b.engine ?? 'meilisearch',
      });
      if (b.attachService) {
        v.attachments = [
          {
            service: b.attachService,
            envVar: v.engine === 'typesense' ? 'TYPESENSE_HOST' : 'MEILI_HOST',
          },
        ];
      }
      st.instances = [...st.instances, v];
      return {
        stack: v.stack,
        name: v.name,
        engine: v.engine,
        host: v.host,
        port: v.port,
        url: v.url,
        keySecret: v.keySecret,
        masterKey: 'demo-Xq3vN8mJd2LrTz7WcYb5Ka0PfHs1',
      };
    },

    'search.destroy': (i, s): { name: string; removed: true } => {
      const st = getState(s);
      const v = require_(st, i);
      st.instances = st.instances.filter((x) => x !== v);
      delete st.backups[key(v.stack, v.name)];
      return { name: v.name, removed: true };
    },

    'search.attachToService': (
      i,
      s,
    ): { appService: string; name: string; envVar: string; url: string; env: Record<string, string> } => {
      const b = i as { appService: string };
      const v = require_(getState(s), i);
      const envVar = v.engine === 'typesense' ? 'TYPESENSE_HOST' : 'MEILI_HOST';
      if (!v.attachments.some((a) => a.service === b.appService)) {
        v.attachments = [...v.attachments, { service: b.appService, envVar }];
      }
      const env: Record<string, string> =
        v.engine === 'typesense'
          ? {
              TYPESENSE_HOST: v.host,
              TYPESENSE_PORT: String(v.port),
              TYPESENSE_PROTOCOL: 'http',
              TYPESENSE_API_KEY_FILE: `/run/secrets/${v.keySecret}`,
            }
          : {
              MEILI_HOST: v.url,
              MEILI_MASTER_KEY_FILE: `/run/secrets/${v.keySecret}`,
            };
      return { appService: b.appService, name: v.name, envVar, url: v.url, env };
    },

    'search.detach': (i, s): { appService: string; name: string; detached: true } => {
      const { appService } = i as { appService: string };
      const v = require_(getState(s), i);
      v.attachments = v.attachments.filter((a) => a.service !== appService);
      return { appService, name: v.name, detached: true };
    },

    'search.backup': (i, s): { resticId: string; sizeBytes: string } => {
      const st = getState(s);
      const v = require_(st, i);
      const id = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      const sizeBytes = String(v.stats?.dbSizeBytes ?? v.stats?.memoryBytes ?? 64 * MB);
      const row: SearchBackupView = {
        id,
        time: nowIso(),
        sizeBytes,
        tags: [`volume:${v.stack}_${v.name}-search-data`, `search:${v.stack}_${v.name}`],
      };
      const k = key(v.stack, v.name);
      st.backups[k] = [row, ...(st.backups[k] ?? [])];
      return { resticId: id, sizeBytes };
    },

    'search.restore': (i, s): { name: string; bytesRestored: string } => {
      const st = getState(s);
      const v = require_(st, i);
      const { snapshotId } = i as { snapshotId: string };
      const snap = (st.backups[key(v.stack, v.name)] ?? []).find((b) => b.id === snapshotId);
      return { name: v.name, bytesRestored: snap?.sizeBytes ?? '0' };
    },

    'search.listBackups': (i, s): SearchBackupView[] => {
      const st = getState(s);
      const v = require_(st, i);
      return st.backups[key(v.stack, v.name)] ?? [];
    },
  },
};
