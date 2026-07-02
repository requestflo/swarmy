import type {
  PgvectorClusterView,
  VectorInstanceView,
  VectorProvisionResult,
  VectorStatsView,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Vector-store demo resolvers — the vector surface (`/data/vector`): qdrant
 * instance list, provision/destroy/attach and the pgvector enablement card.
 * Return shapes mirror `vector.service.ts` views exactly (imported from
 * @swarmy/core, never redeclared). State lives in `store.extra.vector`.
 */

interface VectorState {
  instances: VectorInstanceView[];
  pgvector: PgvectorClusterView[];
}

function getState(store: DemoStore): VectorState {
  return store.extra.vector as VectorState;
}

const nowIso = (): string => new Date().toISOString();

function makeInstance(stack: string, name: string): VectorInstanceView {
  const service = `${stack}_${name}-vector`;
  return {
    stack,
    name,
    kind: 'qdrant',
    service,
    status: 'running',
    desired: 1,
    running: 1,
    host: service,
    port: 6333,
    url: `http://${service}:6333`,
    keySecret: `swarmy-vector-${stack}_${name}-key`,
    stats: null,
    attachments: [],
  };
}

function find(st: VectorState, i: unknown): VectorInstanceView | undefined {
  const { stack, name } = i as { stack: string; name: string };
  return st.instances.find((v) => v.stack === stack && v.name === name);
}

function require_(st: VectorState, i: unknown): VectorInstanceView {
  const v = find(st, i);
  if (!v) throw new Error('vector instance not found');
  return v;
}

export const vector: DomainResolvers = {
  seed: (store) => {
    const search = makeInstance('storefront', 'search');
    search.stats = {
      collections: 3,
      collectionNames: ['docs', 'products', 'support-tickets'],
      at: nowIso(),
    };
    search.attachments = [{ service: 'api', envVar: 'QDRANT_URL' }];

    store.extra.vector = {
      instances: [search],
      pgvector: [
        {
          stack: 'storefront',
          cluster: 'main',
          primaryService: 'storefront_main-primary',
          status: 'running',
          enabled: true,
        },
        {
          stack: 'platform',
          cluster: 'analytics',
          primaryService: 'platform_analytics-primary',
          status: 'running',
          enabled: false,
        },
      ],
    } satisfies VectorState;
  },

  handlers: {
    'vector.list': (_i, s): VectorInstanceView[] =>
      [...getState(s).instances].sort((a, b) =>
        `${a.stack}/${a.name}`.localeCompare(`${b.stack}/${b.name}`),
      ),

    'vector.get': (i, s): VectorInstanceView => require_(getState(s), i),

    'vector.stats': (i, s): VectorStatsView | null => {
      const v = require_(getState(s), i);
      if (!v.stats) return null;
      v.stats = { ...v.stats, at: nowIso() };
      return v.stats;
    },

    'vector.provision': (i, s): VectorProvisionResult => {
      const b = i as { stack: string; name: string; attachService?: string };
      const st = getState(s);
      const v = makeInstance(b.stack, b.name);
      v.stats = { collections: 0, collectionNames: [], at: nowIso() };
      if (b.attachService) v.attachments = [{ service: b.attachService, envVar: 'QDRANT_URL' }];
      st.instances = [...st.instances, v];
      return {
        stack: v.stack,
        name: v.name,
        host: v.host,
        port: v.port,
        url: v.url,
        keySecret: v.keySecret,
        apiKey: 'demo-qdrant-Xk29fJq7Lm4NpR8tWv1Zb6Yc',
      };
    },

    'vector.destroy': (i, s): { name: string; removed: true } => {
      const st = getState(s);
      const v = require_(st, i);
      const { force } = i as { force?: boolean };
      if (v.attachments.length > 0 && !force) {
        throw new Error(
          `${v.attachments.length} service(s) still attached (${v.attachments.map((a) => a.service).join(', ')}) — detach them first or pass force`,
        );
      }
      st.instances = st.instances.filter((x) => x !== v);
      return { name: v.name, removed: true };
    },

    'vector.attachToService': (
      i,
      s,
    ): { appService: string; name: string; envVar: string; url: string; apiKeyFileVar: string } => {
      const b = i as { appService: string; envVar?: string };
      const v = require_(getState(s), i);
      const envVar = b.envVar ?? 'QDRANT_URL';
      if (!v.attachments.some((a) => a.service === b.appService)) {
        v.attachments = [...v.attachments, { service: b.appService, envVar }];
      }
      return {
        appService: b.appService,
        name: v.name,
        envVar,
        url: v.url,
        apiKeyFileVar: envVar.endsWith('_URL')
          ? `${envVar.slice(0, -4)}_API_KEY_FILE`
          : `${envVar}_API_KEY_FILE`,
      };
    },

    'vector.detach': (i, s): { appService: string; name: string; detached: true } => {
      const { appService } = i as { appService: string };
      const v = require_(getState(s), i);
      v.attachments = v.attachments.filter((a) => a.service !== appService);
      return { appService, name: v.name, detached: true };
    },

    'vector.pgvector': (_i, s): PgvectorClusterView[] => getState(s).pgvector,

    'vector.enablePgvector': (i, s): { stack: string; cluster: string; enabled: true } => {
      const { stack, cluster } = i as { stack: string; cluster: string };
      const st = getState(s);
      st.pgvector = st.pgvector.map((c) =>
        c.stack === stack && c.cluster === cluster ? { ...c, enabled: true } : c,
      );
      return { stack, cluster, enabled: true };
    },
  },
};
