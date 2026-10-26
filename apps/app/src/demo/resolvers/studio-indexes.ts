import { indexAdvice, type IndexFacts } from '@swarmy/core/studio';
import type { DomainResolvers } from '../types';

/**
 * `studio.indexAdvice` demo: the storefront app's managed Postgres (`db`),
 * through the controller's own rules (`indexAdvice`), so the words match.
 * The story lines up with the slow queries: `order_items.cart_id` points at
 * carts with no index (the 412 ms `WHERE cart_id = $1`), products is read
 * start to finish for `lower(name) LIKE`, and an old status index on orders
 * hasn't been used since the September reset. One standby copy.
 */

const MB = 1024 * 1024;

const FACTS: IndexFacts = {
  statsReset: '2026-09-01T03:00:00+00:00',
  tables: [
    { table: 'products', seqScan: 3_100, seqRead: 3_100 * 64_000, idxScan: 420, live: 64_000, bytes: 96 * MB },
    { table: 'orders', seqScan: 140, seqRead: 140 * 380, idxScan: 48_210, live: 210_000, bytes: 180 * MB },
    { table: 'order_items', seqScan: 12_400, seqRead: 12_400 * 412_000, idxScan: 15_900, live: 412_000, bytes: 240 * MB },
  ],
  indexes: [
    { index: 'orders_pkey', table: 'orders', scans: 48_000, bytes: 12 * MB, enforces: true },
    { index: 'orders_status_legacy_idx', table: 'orders', scans: 0, bytes: 48 * MB, enforces: false },
    { index: 'products_sku_key', table: 'products', scans: 420, bytes: 4 * MB, enforces: true },
  ],
  foreignKeys: [
    { table: 'order_items', name: 'order_items_cart_id_fkey', references: 'carts', keys: [3], columns: ['cart_id'], indexes: [[1]], live: 412_000 },
    { table: 'order_items', name: 'order_items_product_id_fkey', references: 'products', keys: [2], columns: ['product_id'], indexes: [[1], [2]], live: 412_000 },
  ],
};

export const studioIndexes: DomainResolvers = {
  handlers: {
    'studio.indexAdvice': (i) => {
      const { target } = i as { target: string };
      const empty = { database: null, statsSince: null, standbys: 0, checked: { tables: 0, indexes: 0, foreignKeys: 0 }, tips: [] };
      if (target !== 'db') return { ...empty, unavailable: 'Index suggestions are for Postgres: they read its table and index statistics.' };
      return {
        unavailable: null,
        database: 'storefront',
        statsSince: FACTS.statsReset,
        standbys: 1,
        checked: { tables: FACTS.tables.length, indexes: FACTS.indexes.length, foreignKeys: FACTS.foreignKeys.length },
        tips: indexAdvice(FACTS, { standbys: true }),
      };
    },
  },
};
