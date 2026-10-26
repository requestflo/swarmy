import { describe, expect, it } from 'bun:test';
import { planAppRestore, type AppRestoreDbIn, type AppRestoreVolumeIn } from './app-restore-plan';

const T = Date.parse('2026-10-22T14:00:00Z');
const at = (hhmm: string, day = '2026-10-22'): string => `${day}T${hhmm}:00Z`;
const vol = (volume: string, ...saves: Array<[id: string, startedAt: string, status?: string]>): AppRestoreVolumeIn => ({
  volume,
  saves: saves.map(([id, startedAt, status = 'SUCCEEDED']) => ({ id, startedAt, status })),
});
const db = (cluster: string, saves: Array<[string, string, AppRestoreDbIn['saves'][number]['engine']]>, pitr: AppRestoreDbIn['pitr'] = null): AppRestoreDbIn => ({
  cluster,
  saves: saves.map(([id, time, engine]) => ({ id, time, engine })),
  pitr,
});

describe('planAppRestore', () => {
  it('puts each part on its newest save at or before T and measures the skew', () => {
    const plan = planAppRestore({
      at: T,
      volumes: [vol('shop_uploads', ['v1', at('13:00')], ['v2', at('13:58')], ['v3', at('14:05')])],
      databases: [db('checkout', [['d1', at('13:40'), 'pg_dump'], ['d2', at('14:30'), 'pg_dump']])],
    });
    expect(plan.ok).toBe(true);
    expect(plan.parts.map((p) => [p.name, p.method, p.pointId, p.behindMs / 60_000])).toEqual([
      ['shop_uploads', 'volume', 'v2', 2],
      ['checkout', 'logical', 'd1', 20],
    ]);
    expect(plan.skewMs).toBe(18 * 60_000);
    expect(plan.reachesFrom).toBe(Date.parse(at('13:40')));
  });

  it('lands a PITR cluster on T itself, or the window end when T is past it', () => {
    const pitr = { engine: 'wal-g' as const, window: { from: at('02:00'), to: at('13:59') } };
    const plan = planAppRestore({ at: T, volumes: [], databases: [db('orders', [['d1', at('03:00'), 'pg_dump']], pitr)] });
    expect(plan.parts[0]).toMatchObject({ method: 'pitr', engine: 'wal-g', pointId: null, behindMs: 60_000 });
    const inside = planAppRestore({ at: Date.parse(at('09:00')), volumes: [], databases: [db('orders', [], pitr)] });
    expect(inside.parts[0]).toMatchObject({ method: 'pitr', behindMs: 0 });
  });

  it('falls back to a logical save when T is before the recoverable window', () => {
    const pitr = { engine: 'wal-g' as const, window: { from: at('12:00'), to: at('16:00') } };
    const plan = planAppRestore({ at: Date.parse(at('11:00')), volumes: [], databases: [db('orders', [['d1', at('10:30'), 'pg_dumpall'], ['w1', at('10:45'), 'wal-g']], pitr)] });
    expect(plan.parts[0]).toMatchObject({ method: 'logical', pointId: 'd1', engine: 'pg_dumpall' });
  });

  it('refuses a part that cannot reach T and says where it can go back to', () => {
    const plan = planAppRestore({
      at: T,
      volumes: [vol('shop_uploads', ['v1', at('15:00')], ['v0', at('12:00'), 'FAILED']), vol('shop_media')],
      databases: [db('checkout', [['d1', at('13:00'), 'pg_dump']])],
    });
    expect(plan.ok).toBe(false);
    expect(plan.refused).toEqual([
      { kind: 'volume', name: 'shop_uploads', reachesFrom: Date.parse(at('15:00')) },
      { kind: 'volume', name: 'shop_media', reachesFrom: null },
    ]);
    expect(plan.reachesFrom).toBeNull();
    expect(plan.parts.map((p) => p.name)).toEqual(['checkout']);
  });

  it('has nothing to do for an app with no saved parts', () => {
    const plan = planAppRestore({ at: T, volumes: [], databases: [] });
    expect(plan).toMatchObject({ ok: false, parts: [], refused: [], skewMs: 0, reachesFrom: null });
  });
});
