import { describe, expect, test } from 'bun:test';
import { controllerLane, dbLanes, orderLanes, volumeLanes } from './restore-grid-lanes';
import { lastNight, laneCells, newestCell, nightLabel, nightMonths, nightStarts, type GridSave } from './restore-grid-model';

const DAY = 86_400_000;
const now = Date.parse('2026-09-24T12:00:00Z');
const starts = nightStarts(now);
const at = (daysAgo: number, hh = 3, mm = 0): number => Date.parse('2026-09-24T00:00:00Z') - daysAgo * DAY + hh * 3_600_000 + mm * 60_000;
const save = (atMs: number, status: GridSave['status'] = 'ok', id = String(atMs)): GridSave => ({ id, atMs, status, sizeBytes: '1048576', where: 'B2' });

describe('nights', () => {
  test('14 UTC midnights, oldest first, ending today', () => {
    expect(starts).toHaveLength(14);
    expect(starts[13]).toBe(Date.parse('2026-09-24T00:00:00Z'));
    expect(starts[0]).toBe(Date.parse('2026-09-11T00:00:00Z'));
    expect(nightLabel(starts[0]!, false)).toBe('11');
    expect(nightLabel(starts[13]!, true)).toBe('today');
    expect(nightMonths(starts)).toBe('Sep');
    expect(nightMonths(nightStarts(Date.parse('2026-10-05T12:00:00Z')))).toBe('Sep – Oct');
  });
});

describe('laneCells', () => {
  test('one save a night lands in its night; older ones drop out', () => {
    const cells = laneCells([save(at(0)), save(at(1)), save(at(20))], starts);
    expect(cells[13]?.state).toBe('ok');
    expect(cells[12]?.state).toBe('ok');
    expect(cells.filter(Boolean)).toHaveLength(2);
  });
  test('a failure then a success the same night reads retried, and restores the success', () => {
    const [cell] = laneCells([save(at(5, 3), 'failed', 'a'), save(at(5, 3, 22), 'ok', 'b')], starts).filter(Boolean);
    expect(cell?.state).toBe('retried');
    expect(cell?.save.id).toBe('b');
    expect(cell?.attempts).toHaveLength(2);
  });
  test('only failures read failed; a run in flight reads running', () => {
    expect(laneCells([save(at(2), 'failed')], starts)[11]?.state).toBe('failed');
    expect(laneCells([save(at(0), 'running')], starts)[13]?.state).toBe('running');
  });
});

describe('lastNight and the default pick', () => {
  test('counts each lane’s newest attempt in the last 26 hours', () => {
    const lanes = [
      ...volumeLanes(
        [
          { id: '1', volume: 'shop_db', status: 'SUCCEEDED', targetName: 'B2', sizeBytes: '10', startedAt: new Date(at(0)).toISOString() },
          { id: '2', volume: 'shop_media', status: 'FAILED', targetName: 'B2', sizeBytes: null, startedAt: new Date(at(0)).toISOString(), error: 'lock' },
          { id: '3', volume: 'old_vol', status: 'SUCCEEDED', targetName: 'B2', sizeBytes: '10', startedAt: new Date(at(4)).toISOString() },
        ],
        starts,
      ),
    ];
    expect(lastNight(lanes, now)).toEqual({ saved: 1, total: 2 });
    const pick = newestCell(lanes);
    expect(pick && lanes[pick.lane]!.cells[pick.night]?.save.id).toBe('1');
  });
  test('an empty grid has no pick', () => {
    expect(newestCell([])).toBeNull();
  });
});

describe('lanes from the API', () => {
  test('volumes group by name, drop expired rows and empty lanes', () => {
    const lanes = volumeLanes(
      [
        { id: 'a', volume: 'shop_db', status: 'SUCCEEDED', targetName: 'B2', sizeBytes: '1048576', startedAt: new Date(at(1)).toISOString() },
        { id: 'b', volume: 'shop_db', status: 'PRUNED', targetName: 'B2', sizeBytes: '1048576', startedAt: new Date(at(2)).toISOString() },
        { id: 'c', volume: 'gone_x', status: 'PRUNED', targetName: 'B2', sizeBytes: null, startedAt: new Date(at(1)).toISOString() },
      ],
      starts,
    );
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ kind: 'volume', ref: 'shop_db', name: 'shop’s db data', meta: 'volume · 1.0 MB' });
    expect(lanes[0]!.cells.filter(Boolean)).toHaveLength(1);
  });
  test('database dumps group by their db: tag across destinations', () => {
    const snap = (id: string, d: number) => ({ id, time: new Date(at(d)).toISOString(), engine: 'pg_dump' as const, sizeBytes: '2048', tags: ['org:o', 'db:shop/main', 'engine:pg_dump'] });
    const lanes = dbLanes([{ where: 'B2', snaps: [snap('x', 0)] }, { where: 'NVMe', snaps: [snap('y', 1)] }], starts);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ kind: 'db', ref: 'shop/main', name: 'shop’s main database' });
    expect(lanes[0]!.cells[12]?.save.where).toBe('NVMe');
  });
  test('swarmy itself, and the lane order', () => {
    const ctl = controllerLane(
      [{ id: 'c1', targetId: 't1', status: 'SUCCEEDED', sizeBytes: '48234496', startedAt: new Date(at(0)).toISOString(), error: null }],
      (id) => (id === 't1' ? 'B2' : null),
      starts,
    );
    expect(ctl?.cells[13]?.save.where).toBe('B2');
    const vol = volumeLanes([{ id: 'v', volume: 'shop_media', status: 'SUCCEEDED', targetName: 'B2', sizeBytes: '1', startedAt: new Date(at(0)).toISOString() }], starts);
    const db = dbLanes([{ where: 'B2', snaps: [{ id: 'd', time: new Date(at(0)).toISOString(), engine: 'pg_dump', sizeBytes: '1', tags: ['db:shop/main'] }] }], starts);
    expect(orderLanes([ctl!, ...vol, ...db]).map((l) => l.kind)).toEqual(['db', 'volume', 'controller']);
  });
  test('swarmy itself with no saves in the window is left out', () => {
    expect(controllerLane([], () => null, starts)).toBeNull();
  });
});
