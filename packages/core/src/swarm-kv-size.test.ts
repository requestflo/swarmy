import { describe, expect, test } from 'bun:test';
import type { KvDocMeta } from './swarm-kv';
import { kvFootprint, kvSizeKey, kvSizeLogLine, kvSizeWarnings } from './swarm-kv-size';

const LIMITS = { maxDocBytes: 1_000, maxTotalBytes: 10_000 };

function doc(collection: string, id: string, ...sizes: number[]): KvDocMeta {
  return {
    collection,
    id,
    seq: sizes.length,
    updatedAt: 0,
    bytes: sizes[0]!,
    versions: sizes.map((bytes, i) => ({ seq: sizes.length - i, updatedAt: 0, bytes })),
  };
}

describe('swarm-kv size watch', () => {
  test('nothing near a limit raises nothing', () => {
    expect(kvSizeWarnings([doc('stack', 's1', 700, 600)], LIMITS)).toEqual([]);
  });

  test('a document at 75% of its limit warns; at 95% it is critical', () => {
    const ws = kvSizeWarnings([doc('stack', 's1', 750), doc('stack', 's2', 960), doc('mesh', 'o', 100)], LIMITS);
    expect(ws.map((w) => [w.collection, w.id, w.severity])).toEqual([
      ['stack', 's2', 'crit'],
      ['stack', 's1', 'warn'],
    ]);
  });

  test('only the latest version counts against the document limit', () => {
    expect(kvSizeWarnings([doc('stack', 's1', 100, 990, 990)], LIMITS)).toEqual([]);
  });

  test('the footprint counts every kept version against the 2 MB-style budget', () => {
    const docs = Array.from({ length: 4 }, (_, i) => doc('stack', `s${i}`, 700, 700, 700));
    expect(kvFootprint(docs)).toBe(8_400);
    const [w] = kvSizeWarnings(docs, LIMITS);
    expect(w).toMatchObject({ scope: 'total', bytes: 8_400, limit: 10_000, severity: 'warn' });
  });

  test('log lines name the document, the size and the limit', () => {
    const [crit] = kvSizeWarnings([doc('stack', 's2', 960)], LIMITS);
    expect(kvSizeLogLine('org1', crit!)).toBe(
      '[swarm-kv] org org1: document stack/s2 is 0.9 KB of its 1.0 KB limit (96%) — the next save may be refused',
    );
  });

  test('the change key ignores small growth but not a new document or a 5% step', () => {
    const a = kvSizeWarnings([doc('stack', 's1', 760)], LIMITS);
    const b = kvSizeWarnings([doc('stack', 's1', 790)], LIMITS);
    const c = kvSizeWarnings([doc('stack', 's1', 810)], LIMITS);
    expect(kvSizeKey(a)).toBe(kvSizeKey(b));
    expect(kvSizeKey(a)).not.toBe(kvSizeKey(c));
  });
});
