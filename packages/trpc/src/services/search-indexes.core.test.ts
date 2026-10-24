import { describe, expect, it } from 'bun:test';
import { indexPath, meiliProblem, meiliScript, meiliSettingsScript, splitResponses } from './search-indexes.core';
import { hitView, parseIndexList, parseQuery, parseSettings, parseTask } from './search-indexes.parse';

const M = '@@0123456789abcdef';

describe('meiliScript — Meilisearch over curl inside the container', () => {
  it('reads the key from the secret file and hands it to curl on stdin, never argv', () => {
    const s = meiliScript([{ method: 'GET', path: '/stats' }], M);
    expect(s).toContain('KEY="$(cat /run/secrets/search-master-key)"');
    expect(s).toContain(`printf 'Authorization: Bearer %s\\n' "$KEY" | curl -sS -X GET -H @-`);
    expect(s).not.toContain('--header=');
    expect(s).toContain(`-w '\\n${M} %{http_code}\\n' "http://localhost:7700/stats"`);
  });

  it('a body is the script argument $1, never spliced into the script', () => {
    const s = meiliScript([{ method: 'POST', path: indexPath('products', '/search'), body: true }], M);
    expect(s).toContain(`--data-binary "$1"`);
    expect(s).toContain('"http://localhost:7700/indexes/products/search"');
  });

  it('refuses index uids and markers that could break out of the script', () => {
    expect(() => indexPath('products"; rm -rf /')).toThrow();
    expect(() => indexPath('a/b')).toThrow();
    expect(() => meiliScript([], '@@x; id')).toThrow();
  });

  it('a settings write polls its task for a bounded number of seconds', () => {
    const s = meiliSettingsScript('products', M);
    expect(s).toContain('-X PATCH');
    expect(s).toContain('"http://localhost:7700/tasks/$T"');
    expect(s).toMatch(/while \[ "\$i" -lt \d+ \]/);
  });
});

describe('splitResponses / meiliProblem', () => {
  it('splits on the nonce marker, so a document quoting a marker cannot split it', () => {
    const out = `{"hits":[{"t":"@@status 200"}]}\n${M} 200\n{"message":"Index \`x\` not found.","code":"index_not_found"}\n${M} 404\n`;
    const rs = splitResponses(out, M);
    expect(rs.map((r) => r.status)).toEqual([200, 404]);
    expect(meiliProblem(rs[0])).toBeNull();
    expect(meiliProblem(rs[1])).toEqual({ kind: 'notFound', message: 'Index `x` not found.' });
    expect(meiliProblem(undefined)?.kind).toBe('unreachable');
    expect(meiliProblem({ status: 0, body: null, raw: '' })?.kind).toBe('unreachable');
    expect(meiliProblem({ status: 400, body: { message: 'bad filter' }, raw: '' })).toEqual({ kind: 'refused', message: 'bad filter' });
  });
});

describe('parsers — capped views', () => {
  it('joins /indexes with /stats, newest change first', () => {
    const list = parseIndexList(
      {
        results: [
          { uid: 'pages', primaryKey: 'id', updatedAt: '2026-10-01T00:00:00Z' },
          { uid: 'products', primaryKey: 'sku', updatedAt: '2026-10-24T09:00:00Z' },
        ],
        total: 2,
      },
      { databaseSize: 400, indexes: { products: { numberOfDocuments: 41208, rawDocumentDbSize: 312, isIndexing: true } } },
    );
    expect(list).toEqual({
      total: 2,
      dbSizeBytes: 400,
      indexes: [
        { uid: 'products', primaryKey: 'sku', docs: 41208, sizeBytes: 312, updatedAt: '2026-10-24T09:00:00Z', isIndexing: true },
        { uid: 'pages', primaryKey: 'id', docs: 0, sizeBytes: null, updatedAt: '2026-10-01T00:00:00Z', isIndexing: false },
      ],
    });
    expect(parseIndexList({ message: 'nope' }, {})).toBeNull();
  });

  it('settings: searchable defaults to every field; filter objects give their patterns', () => {
    const s = parseSettings({
      searchableAttributes: [],
      filterableAttributes: ['price', { attributePatterns: ['category'], features: {} }],
      synonyms: { mug: ['cup'], cup: ['mug'] },
    });
    expect(s).toMatchObject({ searchable: ['*'], filterable: ['price', 'category'], synonymWords: 2, synonymsTruncated: false });
  });

  it('a hit becomes a title, a short meta line and its score', () => {
    expect(
      hitView({ sku: 'MUG-1', title: 'Enamel mug', brand: 'Northwind', price: 18, _rankingScore: 0.97, _formatted: {} }, 'sku'),
    ).toEqual({ id: 'MUG-1', title: 'Enamel mug', meta: 'brand: Northwind · price: 18', score: 0.97 });
    expect(hitView({ id: 7, body: 'x'.repeat(500) }, null).title.length).toBeLessThanOrEqual(120);
    const q = parseQuery({ hits: Array.from({ length: 9 }, (_, i) => ({ id: i })), processingTimeMs: 3, estimatedTotalHits: 120 }, null, 5);
    expect(q?.hits.length).toBe(5);
    expect(q).toMatchObject({ estimatedTotal: 120, processingTimeMs: 3 });
    expect(parseTask({ uid: 9, status: 'failed', error: { message: 'unknown field' } })).toEqual({ taskUid: 9, status: 'failed', error: 'unknown field' });
  });
});
