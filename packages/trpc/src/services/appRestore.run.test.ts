import { describe, expect, it } from 'bun:test';
import type { AppRestorePart } from '@swarmy/core';
import { runAppRestore, type AppRestoreSteps } from './appRestore.run';
import { failureWords } from './appRestore.words';

const vol = (name: string): AppRestorePart => ({ kind: 'volume', name, method: 'volume', pointId: `p-${name}`, engine: null, at: 1, behindMs: 0 });
const db = (name: string, method: 'logical' | 'pitr' = 'logical'): AppRestorePart => ({
  kind: 'database',
  name,
  method,
  pointId: method === 'pitr' ? null : `p-${name}`,
  engine: method === 'pitr' ? 'wal-g' : 'pg_dump',
  at: 1,
  behindMs: 0,
});

/** Steps that record every call; `fail` names the step:part that throws. */
function fake(fail: string[] = []): { steps: AppRestoreSteps; calls: string[] } {
  const calls: string[] = [];
  const step = async (name: string, part?: AppRestorePart): Promise<void> => {
    const key = part ? `${name}:${part.name}` : name;
    calls.push(key);
    if (fail.includes(key)) throw new Error(`${key} broke`);
  };
  return {
    calls,
    steps: {
      stop: () => step('stop'),
      start: async () => (await step('start'), null),
      saveVolume: async (p) => (await step('save', p), `safe-${p.name}`),
      restoreVolume: (p) => step('restore', p),
      restoreDb: async (p, onSafety) => {
        calls.push(`save:${p.name}`);
        if (fail.includes(`save:${p.name}`)) throw new Error('safety copy failed: nothing restored');
        onSafety(`safe-${p.name}`);
        await step('restore', p);
      },
      undoVolume: (p, id) => step(`undo(${id})`, p),
      undoDb: (p, id) => step(`undo(${id})`, p),
    },
  };
}

describe('runAppRestore', () => {
  it('stops once, saves then restores volumes before databases, and starts again', async () => {
    const { steps, calls } = fake();
    const run = await runAppRestore([db('checkout'), vol('shop_uploads')], steps);
    expect(run.ok).toBe(true);
    expect(calls).toEqual(['stop', 'save:shop_uploads', 'restore:shop_uploads', 'save:checkout', 'restore:checkout', 'start']);
    expect(run.parts.map((p) => [p.name, p.status, p.safetySnapshotId])).toEqual([
      ['shop_uploads', 'restored', 'safe-shop_uploads'],
      ['checkout', 'restored', 'safe-checkout'],
    ]);
  });

  it('puts every written part back, newest first, when a database fails part-way', async () => {
    const { steps, calls } = fake(['restore:checkout']);
    const run = await runAppRestore([vol('shop_uploads'), vol('shop_media'), db('checkout'), db('orders')], steps);
    expect(run.ok).toBe(false);
    expect(calls.slice(-4)).toEqual(['undo(safe-checkout):checkout', 'undo(safe-shop_media):shop_media', 'undo(safe-shop_uploads):shop_uploads', 'start']);
    expect(run.parts.map((p) => [p.name, p.status, p.undo ?? null])).toEqual([
      ['shop_uploads', 'restored', 'done'],
      ['shop_media', 'restored', 'done'],
      ['checkout', 'failed', 'done'],
      ['orders', 'skipped', null],
    ]);
    expect(failureWords('shop', run)).toBe(
      'Restoring checkout failed: restore:checkout broke. shop_uploads, shop_media and checkout were put back from the copy saved first. shop was started again.',
    );
  });

  it('leaves a part alone when its safety copy failed, and trusts a failed PITR to have put itself back', async () => {
    const a = fake(['save:shop_media']);
    const ra = await runAppRestore([vol('shop_uploads'), vol('shop_media')], a.steps);
    expect(a.calls).toEqual(['stop', 'save:shop_uploads', 'restore:shop_uploads', 'save:shop_media', 'undo(safe-shop_uploads):shop_uploads', 'start']);
    expect(ra.parts[1]).toMatchObject({ status: 'failed', safetySnapshotId: null });

    const b = fake(['restore:orders']);
    await runAppRestore([vol('shop_uploads'), db('orders', 'pitr')], b.steps);
    expect(b.calls.filter((c) => c.startsWith('undo'))).toEqual(['undo(safe-shop_uploads):shop_uploads']);
  });

  it('says which part could not be put back, with its saved copy', async () => {
    const { steps } = fake(['restore:checkout', 'undo(safe-shop_uploads):shop_uploads']);
    const run = await runAppRestore([vol('shop_uploads'), db('checkout')], steps);
    expect(failureWords('shop', run)).toContain('Putting shop_uploads back failed (undo(safe-shop_uploads):shop_uploads broke); its saved copy is safe-shop_uploads');
  });

  it('touches nothing when the app would not stop', async () => {
    const { steps, calls } = fake(['stop']);
    await expect(runAppRestore([vol('shop_uploads')], steps)).rejects.toThrow('stop broke');
    expect(calls).toEqual(['stop']);
  });
});
