import { describe, expect, it } from 'bun:test';
import { SwapSearchIndexInput, swapProblem } from './search-swap';

const live = { uid: 'products', primaryKey: 'sku', docs: 41_208 };

describe('swapProblem (board 41 reindex by swap)', () => {
  it('a full rebuild keyed the same way swaps', () => {
    expect(swapProblem(live, { uid: 'products_next', primaryKey: 'sku', docs: 41_190 })).toBeNull();
    expect(swapProblem(live, { uid: 'products_next', primaryKey: null, docs: 3 })).toBeNull();
  });

  it('refuses itself, an empty index, one still filling, and a different index', () => {
    expect(swapProblem(live, { ...live })).toBe('pick another index to swap in');
    expect(swapProblem(live, { uid: 'products_next', primaryKey: 'sku', docs: 0 })).toBe('products_next has no documents: swapping it in would empty products');
    expect(swapProblem(live, { uid: 'products_next', primaryKey: 'sku', docs: 9, isIndexing: true })).toMatch(/still taking documents in/);
    expect(swapProblem(live, { uid: 'pages', primaryKey: 'slug', docs: 6_591 })).toBe(
      "pages keys its documents by slug and products by sku: it's a different index, not a rebuild of this one",
    );
  });

  it('the input takes index names only', () => {
    expect(SwapSearchIndexInput.safeParse({ stack: 'shop', name: 'main', index: 'products', with: 'products_next', confirm: 'products' }).success).toBe(true);
    expect(SwapSearchIndexInput.safeParse({ stack: 'shop', name: 'main', index: 'products', with: '../x', confirm: 'products' }).success).toBe(false);
  });
});
