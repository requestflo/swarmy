import { describe, expect, it } from 'bun:test';
import { postgisWords, restartClause, statementsWords, type PgExtensionView, type PgExtensionsView } from './pg-extension-words';

const stats = (over: Partial<PgExtensionView> = {}): PgExtensionView => ({
  name: 'pg_stat_statements', on: false, wanted: false, available: true, restartsCopies: true, canDisable: true, ...over,
});
const gis = (over: Partial<PgExtensionView> = {}): PgExtensionView => ({
  name: 'postgis', on: false, wanted: false, available: false, restartsCopies: false, canDisable: false, ...over,
});
const view = (over: Partial<PgExtensionsView> = {}): PgExtensionsView => ({
  stack: 'shop', cluster: 'main', image: 'pgvector/pgvector:pg17', copies: 2, extensions: [], progress: null, error: null, ...over,
});

describe('extension words (board 39)', () => {
  it('says the restart up front: standbys first, then the main copy in place', () => {
    expect(restartClause(view())).toBe('restarts each copy: the 1 standby copy first, then the main copy in place (a few seconds without writes)');
    expect(restartClause(view({ copies: 1 }))).toBe('restarts the database once, in place (a few seconds offline)');
    expect(statementsWords(stats(), view()).sentence).toContain('Turning it on restarts each copy');
  });

  it('follows the reconcile while it restarts copies', () => {
    const w = statementsWords(stats({ wanted: true }), view({ progress: { kind: 'restart', phase: 'writer', services: ['p'], reason: null } }));
    expect(w).toMatchObject({ busy: true, canToggle: false });
    expect(w.sentence).toBe('Turning on: restarting the main copy in place, a few seconds without writes.');
  });

  it('postgis: never faked when the image lacks it', () => {
    const w = postgisWords(gis(), view());
    expect(w.canToggle).toBe(false);
    expect(w.sentence).toBe('Needs a PostGIS image. This database runs pgvector/pgvector:pg17, which doesn’t include it.');
    expect(postgisWords(gis({ available: true }), view()).canToggle).toBe(true);
    expect(postgisWords(gis({ on: true, wanted: true, available: true }), view()).canToggle).toBe(false);
  });

  it('a failed CREATE is said plainly and can be retried', () => {
    const w = statementsWords(stats({ wanted: true }), view({ error: 'pg_stat_statements: permission denied' }));
    expect(w).toMatchObject({ canToggle: true, busy: false, sentence: 'Couldn’t turn it on: pg_stat_statements: permission denied' });
  });
});
