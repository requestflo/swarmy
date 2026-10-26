import type {
  SearchIndexListView,
  SearchIndexSettingsView,
  SearchIndexView,
  SearchInstanceView,
  SearchQueryView,
  SearchSettingsResult,
  SetIndexSettingsInput,
  SearchSwapResult,
  SwapSearchIndexInput,
} from '@swarmy/core';
import { swapProblem } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { seedIndexes, type DemoIndex } from './searchsvc-indexes-seed';
import { demoQuery } from './searchsvc-query';

/**
 * Demo resolvers for a search instance's indexes (board 41): the list, one
 * index's settings, "Try it", editing settings. Shapes are the @swarmy/core views search-indexes.service
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

    'search.setIndexSettings': (i, s): SearchSettingsResult => {
      const ix = indexOf(s, i);
      const b = i as SetIndexSettingsInput;
      const changed: SearchSettingsResult['changed'] = [];
      if (b.searchable) {
        ix.searchable = b.searchable.length ? b.searchable : ['*'];
        changed.push('searchable');
      }
      if (b.filterable) {
        ix.filterable = b.filterable;
        changed.push('filterable');
      }
      if (b.synonyms) {
        ix.synonyms = b.synonyms;
        changed.push('synonyms');
      }
      ix.updatedAt = new Date().toISOString();
      // A big index is still re-indexing when swarmy stops waiting, as in life.
      return { index: ix.uid, taskUid: 8800 + changed.length, status: ix.docs > 10_000 ? 'processing' : 'succeeded', error: null, changed };
    },

    // Reindex by swap: the same refusals as the controller (swapProblem), then the two trade names.
    'search.swapIndex': (i, s): SearchSwapResult => {
      const b = i as SwapSearchIndexInput;
      if (b.confirm !== b.index) throw new Error(`type ${b.index} to swap it`);
      const live = indexOf(s, i);
      const next = indexOf(s, { ...b, index: b.with });
      const problem = swapProblem(view(live), view(next));
      if (problem) throw new Error(problem);
      [live.uid, next.uid] = [next.uid, live.uid];
      live.updatedAt = new Date(Date.now() - 1_000).toISOString();
      next.updatedAt = new Date().toISOString();
      return { index: b.index, with: b.with, taskUid: 8900, status: 'succeeded', error: null };
    },
  },
};
