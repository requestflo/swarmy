import { describe, expect, test } from 'bun:test';
import type { SearchIndexView } from '@swarmy/core';
import { fieldsWords, indexLine, parseFields, queryMeta, reindexLine, synonymsLine } from './search-words';

const ix = (over: Partial<SearchIndexView> = {}): SearchIndexView => ({
  uid: 'products',
  primaryKey: 'sku',
  docs: 41_208,
  sizeBytes: 312 * 1024 * 1024,
  updatedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  isIndexing: false,
  ...over,
});

describe('search words (board 41)', () => {
  test('an index line: documents, size, last change', () => {
    expect(indexLine(ix())).toBe('41,208 docs · 312 MB · updated 4m ago');
    expect(indexLine(ix({ docs: 1, sizeBytes: null, isIndexing: true }))).toBe('1 doc · indexing now');
  });

  test('searchable `*` reads as every field', () => {
    expect(fieldsWords(['*'])).toEqual([]);
    expect(fieldsWords(['title', 'sku'])).toEqual(['title', 'sku']);
  });

  test('synonyms: the set count, then the first few', () => {
    const map = { cup: ['mug'], mug: ['cup'], 't-shirt': ['tee'], tee: ['t-shirt'], phone: ['smartphone'] };
    expect(synonymsLine(map, 5)).toBe('3 sets · cup = mug, phone -> smartphone, …');
    expect(synonymsLine({}, 0)).toBe('none yet');
    expect(synonymsLine({ cup: ['mug'], mug: ['cup'] }, 400)).toBe('1+ set · cup = mug');
  });

  test('the Try it meta line', () => {
    const r = { index: 'products', q: 'mug', hits: [{ id: '1', title: 'Mug', meta: '', score: 0.9 }], estimatedTotal: 120, processingTimeMs: 3 };
    expect(queryMeta(r)).toBe('1 of about 120 · 3 ms');
    expect(queryMeta({ ...r, hits: [] })).toBe('Nothing matches “mug” · 3 ms');
  });

  test('a comma list of fields is trimmed and de-duplicated', () => {
    expect(parseFields(' title, brand ,, title')).toEqual(['title', 'brand']);
  });

  test('the Reindex row names the app that keeps the index in sync', () => {
    expect(reindexLine({ attachments: [{ service: 'storefront_web', envVar: 'MEILI_HOST' }] }, 'products')).toBe(
      'web keeps products in sync. To rebuild it, web writes a fresh copy into a second index and swarmy swaps it in.',
    );
    expect(reindexLine({ attachments: [] }, 'products')).toMatch(/^your app keeps products/);
  });
});
