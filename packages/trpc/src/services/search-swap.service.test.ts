import { describe, expect, it } from 'bun:test';
import { swapSearchIndex } from './search-swap.service';
import { ctxWith } from './search-testing';

const input = { stack: 'shop', name: 'main', index: 'products', with: 'products_next', confirm: 'products' };
const idx = (uid: string, primaryKey: string): [number, unknown] => [200, { uid, primaryKey }];
const stats = (n: number, indexing = false): [number, unknown] => [200, { numberOfDocuments: n, isIndexing: indexing }];

/** The reads (both indexes and their stats), then the swap and its task. */
const engine =
  (next: Array<[number, unknown]>, swap: Array<[number, unknown]> = [[202, { taskUid: 90, status: 'enqueued' }], [200, { uid: 90, status: 'succeeded' }]]) =>
  (script: string): Array<[number, unknown]> =>
    script.includes('/swap-indexes') ? swap : [idx('products', 'sku'), stats(41_208), ...next];

describe('swapSearchIndex (board 41 reindex by swap)', () => {
  it('reads both sides, swaps with the pair as $1, waits for the task, audits once', async () => {
    const { ctx, audit, sent } = ctxWith('owner', engine([idx('products_next', 'sku'), stats(41_190)]));
    const r = await swapSearchIndex(ctx, input);
    expect(r).toEqual({ index: 'products', with: 'products_next', taskUid: 90, status: 'succeeded', error: null });
    const swap = sent[1]!.payload.cmd;
    expect(swap[2]).toContain('-X POST');
    expect(swap[2]).toContain('/swap-indexes');
    expect(JSON.parse(swap[4]!)).toEqual([{ indexes: ['products', 'products_next'] }]);
    expect(audit.map((a) => a.action)).toEqual(['search.index.swap']);
    expect(audit[0]!.metadata).toMatchObject({ index: 'products', with: 'products_next', status: 'succeeded', docs: { products: 41_208, products_next: 41_190 } });
  });

  it('the typed confirmation must be the live index’s name; nothing is asked of the engine', async () => {
    const { ctx, sent } = ctxWith('owner', engine([]));
    await expect(swapSearchIndex(ctx, { ...input, confirm: 'product' })).rejects.toThrow('type products to swap it');
    expect(sent).toHaveLength(0);
  });

  it('an empty or differently keyed index is refused before any swap, and audited', async () => {
    const empty = ctxWith('owner', engine([idx('products_next', 'sku'), stats(0)]));
    await expect(swapSearchIndex(empty.ctx, input)).rejects.toThrow('would empty products');
    expect(empty.sent).toHaveLength(1);
    expect(empty.audit[0]!.metadata).toMatchObject({ status: 'refused' });
    const other = ctxWith('owner', engine([idx('pages', 'slug'), stats(6_591)]));
    await expect(swapSearchIndex(other.ctx, { ...input, with: 'pages' })).rejects.toThrow('different index');
  });

  it('an index that is gone is not found; a failed task carries the engine’s reason', async () => {
    const gone = ctxWith('owner', engine([[404, { code: 'index_not_found', message: 'Index `products_next` not found.' }], stats(0)]));
    await expect(swapSearchIndex(gone.ctx, input)).rejects.toThrow(/not found/i);
    const failed = ctxWith('owner', engine([idx('products_next', 'sku'), stats(10)], [[202, { taskUid: 3 }], [200, { uid: 3, status: 'failed', error: { message: 'swap refused' } }]]));
    await expect(swapSearchIndex(failed.ctx, input)).rejects.toThrow('swap refused');
    expect(failed.audit[0]!.metadata).toMatchObject({ status: 'failed' });
  });
});
