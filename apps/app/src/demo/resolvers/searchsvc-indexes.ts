import type { SearchIndexListView, SearchIndexSettingsView, SearchIndexView, SearchInstanceView, SearchQueryView } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { seedIndexes, type DemoIndex } from './searchsvc-indexes-seed';
import { demoQuery } from './searchsvc-query';

/**
 * Demo resolvers for a search instance's indexes (board 41): the list, one
 * index's settings, "Try it". Shapes are the @swarmy/core views search-indexes.service
 * returns. State lives in `store.extra.searchidx` (`<stack>/<name>` → indexes);
 * an instance made in the demo starts with none, as a real one does.
 */
type IdxState = Record<string, DemoIndex[]>;

export function idxState(store: DemoStore): IdxState {
  store.extra.searchidx ??= {};
  return store.extra.searchidx as IdxState;
}

const ref = (i: unknown): { stack: string; name: string; index?: string } =>
  i as { stack: string; name: string; index?: string };

export function instanceOf(store: DemoStore, i: unknown): SearchInstanceView {
  const { stack, name } = ref(i);
  const st = store.extra.searchsvc as { instances: SearchInstanceView[] } | undefined;
  const v = st?.instances.find((x) => x.stack === stack && x.name === name);
  if (!v) throw new Error('search instance not found');
  return v;
}

export function indexOf(store: DemoStore, i: unknown): DemoIndex {
  const { stack, name, index } = ref(i);
  instanceOf(store, i);
  const ix = (idxState(store)[`${stack}/${name}`] ?? []).find((x) => x.uid === index);
  if (!ix) throw new Error(`Index \`${index ?? ''}\` not found.`);
  return ix;
}

const view = (ix: DemoIndex): SearchIndexView => ({
  uid: ix.uid,
  primaryKey: ix.primaryKey,
  docs: ix.docs,
  sizeBytes: ix.sizeBytes,
  updatedAt: ix.updatedAt,
  isIndexing: false,
});

export const searchsvcIndexes: DomainResolvers = {
  seed: (store) => {
    store.extra.searchidx = seedIndexes();
  },
  handlers: {
    'search.indexes': (i, s): SearchIndexListView => {
      const v = instanceOf(s, i);
      const list = idxState(s)[`${v.stack}/${v.name}`] ?? [];
      const base = { stack: v.stack, name: v.name, sampledAt: new Date().toISOString() };
      if (v.engine !== 'meilisearch') return { ...base, supported: false, indexes: [], total: 0, truncated: false, dbSizeBytes: null };
      const indexes = list.map(view).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      return { ...base, supported: true, indexes, total: indexes.length, truncated: false, dbSizeBytes: v.stats?.dbSizeBytes ?? null };
    },

    'search.index': (i, s): SearchIndexSettingsView => {
      const v = instanceOf(s, i);
      const ix = indexOf(s, i);
      return {
        stack: v.stack,
        name: v.name,
        ...view(ix),
        searchable: ix.searchable,
        filterable: ix.filterable,
        sortable: ix.sortable,
        synonyms: ix.synonyms,
        synonymWords: Object.keys(ix.synonyms).length,
        synonymsTruncated: false,
      };
    },

    'search.query': (i, s): SearchQueryView => {
      const ix = indexOf(s, i);
      const { q } = i as { q: string };
      return { index: ix.uid, q, ...demoQuery(ix, q) };
    },
  },
};
