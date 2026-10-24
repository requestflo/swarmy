import { describe, expect, it } from 'bun:test';
import { searchIndexes, searchQuery } from './search-indexes.service';
import { ctxWith } from './search-testing';

/**
 * Service wiring over a fake hub: every index call is ONE `exec` in the
 * engine's running container (never a published port), the script carries
 * no key and no user text, reads are audited, and "Try it" runs the
 * `data.read` gate before it touches the engine.
 */

describe('search indexes service', () => {
  it('lists indexes with one exec in the engine container and audits the read', async () => {
    const { ctx, audit, sent } = ctxWith('owner', () => [
      [200, { results: [{ uid: 'products', primaryKey: 'sku', updatedAt: '2026-10-24T09:00:00Z' }], total: 1 }],
      [200, { databaseSize: 9, indexes: { products: { numberOfDocuments: 41208 } } }],
    ]);
    const v = await searchIndexes(ctx, { stack: 'shop', name: 'main' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ node: 'node-a', cmd: 'exec', payload: { target: { containerId: 'ctr-search' } } });
    expect(sent[0]!.payload.cmd.slice(0, 2)).toEqual(['sh', '-c']);
    expect(v).toMatchObject({ supported: true, total: 1, truncated: false, dbSizeBytes: 9 });
    expect(v.indexes[0]).toMatchObject({ uid: 'products', docs: 41208 });
    expect(audit.map((a) => a.action)).toEqual(['search.indexes.read']);
  });

  it('a Typesense instance says unsupported without touching the engine', async () => {
    const { ctx, sent } = ctxWith('owner', () => [], { labels: { 'swarmy.search.engine': 'typesense' } });
    expect(await searchIndexes(ctx, { stack: 'shop', name: 'main' })).toMatchObject({ supported: false, indexes: [] });
    expect(sent).toHaveLength(0);
  });

  it('Try it sends the query as $1 (never in the script) and records one search.query row', async () => {
    const { ctx, audit, sent } = ctxWith('owner', () => [
      [200, { uid: 'products', primaryKey: 'sku' }],
      [200, { hits: [{ sku: 'MUG-1', title: 'Enamel mug', _rankingScore: 0.9 }], processingTimeMs: 2, estimatedTotalHits: 7 }],
    ]);
    const q = 'mug"; cat /run/secrets/search-master-key; echo "';
    const r = await searchQuery(ctx, { stack: 'shop', name: 'main', index: 'products', q });
    const cmd = sent[0]!.payload.cmd;
    expect(cmd[2]).not.toContain('mug"');
    expect(JSON.parse(cmd[4]!)).toEqual({ q, limit: 5, showRankingScore: true });
    expect(r).toMatchObject({ estimatedTotal: 7, processingTimeMs: 2, hits: [{ id: 'MUG-1', title: 'Enamel mug', score: 0.9 }] });
    expect(audit.map((a) => a.action)).toEqual(['search.query']);
  });

  it('a member is refused Try it on a production stack — audited, the engine never asked', async () => {
    const { ctx, audit, sent } = ctxWith('member', () => [], { labels: { 'swarmy.env': 'production' } });
    await expect(searchQuery(ctx, { stack: 'shop', name: 'main', index: 'products', q: 'mug' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(sent).toHaveLength(0);
    expect(audit.map((a) => a.action)).toEqual(['authz.deny:data.read']);
  });

  it('a 404 from the engine is NOT_FOUND', async () => {
    const { ctx } = ctxWith('owner', () => [[404, { message: 'Index `nope` not found.', code: 'index_not_found' }]]);
    await expect(searchQuery(ctx, { stack: 'shop', name: 'main', index: 'nope', q: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
