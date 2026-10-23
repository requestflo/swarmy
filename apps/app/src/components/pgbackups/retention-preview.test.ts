import { describe, expect, test } from 'bun:test';
import { retentionChoices, retentionPreview, type CatalogPoint } from './retention-preview';

const DAY = 86_400_000;
const now = Date.parse('2026-10-23T12:00:00Z');
const at = (daysAgo: number, engine: CatalogPoint['engine'] = 'pg_dump'): CatalogPoint => ({
  id: `s${daysAgo}`,
  time: new Date(now - daysAgo * DAY).toISOString(),
  engine,
  sizeBytes: '1000',
});
// Thirty nightly dumps, newest yesterday.
const nightly = Array.from({ length: 30 }, (_, i) => at(i + 1));

describe('retentionChoices', () => {
  test('the four windows, plus a custom current one', () => {
    expect(retentionChoices(14)).toEqual([7, 14, 30, 90]);
    expect(retentionChoices(21)).toEqual([7, 14, 21, 30, 90]);
    expect(retentionChoices(null)).toEqual([7, 14, 30, 90]);
  });
});

describe('retentionPreview', () => {
  test('a shorter window marks the older saves', () => {
    const p = retentionPreview(nightly, 14, { nowMs: now, engine: 'pg_dump' });
    expect(p.kept).toBe(14);
    expect(p.pruned).toBe(16);
    expect(p.points[0]!.keep).toBe(false);
    expect(p.points.at(-1)!.keep).toBe(true);
    // oldest at the left edge, newest near the right
    expect(p.points[0]!.frac).toBe(0);
    expect(p.points.at(-1)!.frac).toBeGreaterThan(0.95);
  });

  test('measures from the next save, which is when the prune runs', () => {
    const p = retentionPreview(nightly, 14, { nowMs: now, nextRunMs: now + DAY / 2, engine: 'pg_dump' });
    // the 14-day-old save is older than (next run − 14 d) by then
    expect(p.kept).toBe(13);
  });

  test('a longer window keeps everything and stretches the strip', () => {
    const p = retentionPreview(nightly, 90, { nowMs: now, engine: 'pg_dump' });
    expect(p.pruned).toBe(0);
    expect(p.keepFrac).toBe(1);
    expect(p.fromMs).toBe(now - 90 * DAY);
  });

  test('only the schedule’s own engine is pruned', () => {
    const mixed = [...nightly.slice(0, 5), at(40, 'pg_dumpall')];
    const p = retentionPreview(mixed, 7, { nowMs: now, engine: 'pg_dump' });
    expect(p.points.find((x) => x.id === 's40')!.keep).toBe(true);
  });

  test('physical engines never prune through restic', () => {
    const p = retentionPreview([at(20, 'wal-g'), at(2, 'wal-g')], 7, { nowMs: now, engine: 'wal-g' });
    expect(p.pruned).toBe(0);
  });

  test('no schedule means nothing is pruned', () => {
    expect(retentionPreview(nightly, 7, { nowMs: now, engine: null }).pruned).toBe(0);
  });

  test('an empty catalog still draws the window', () => {
    const p = retentionPreview([], 14, { nowMs: now, engine: 'pg_dump' });
    expect(p.points).toEqual([]);
    expect(p.keepFrac).toBe(1);
  });
});
