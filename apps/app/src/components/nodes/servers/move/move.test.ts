import { describe, expect, test } from 'bun:test';
import { MOVE_STATE_LABEL } from '@swarmy/core';
import { fitCheck, needFromUsage, roomiest, TIGHT_PCT, WONT_FIT_PCT } from './fit-check';
import { movePhase, moveStep, START_GRACE_MS, subjectBlock, targetBlock, volumesFromInspect, type MoveSubject } from './move-rules';
import { previewWords } from './move-words';

const GB = 1024 ** 3;

describe('fitCheck', () => {
  const dest = { usedBytes: 6 * GB, totalBytes: 16 * GB }; // 38%

  test('fits with room: before → after, free, and what it frees at the source', () => {
    const f = fitCheck({ needBytes: 2 * GB, dest, source: { usedBytes: 12 * GB, totalBytes: 16 * GB } });
    expect(f).toEqual({
      verdict: 'fits',
      needBytes: 2 * GB,
      beforePct: 38,
      afterPct: 50,
      freeBytes: 10 * GB,
      source: { beforePct: 75, afterPct: 63 },
    });
  });

  test(`tight above ${TIGHT_PCT}%, won't fit above ${WONT_FIT_PCT}% or past the free memory`, () => {
    expect(fitCheck({ needBytes: 7.2 * GB, dest }).verdict).toBe('tight'); // 83%
    expect(fitCheck({ needBytes: 8.8 * GB, dest }).verdict).toBe('wont-fit'); // 93%
    expect(fitCheck({ needBytes: 11 * GB, dest }).verdict).toBe('wont-fit'); // more than free
    expect(fitCheck({ needBytes: 6.8 * GB, dest }).verdict).toBe('fits'); // 80% exactly
  });

  test('unknown without a memory reading or without live numbers — never a fake zero', () => {
    expect(fitCheck({ needBytes: null, dest })).toMatchObject({ verdict: 'unknown', beforePct: 38, afterPct: null });
    expect(fitCheck({ needBytes: GB, dest: null })).toMatchObject({ verdict: 'unknown', beforePct: null, freeBytes: null });
    expect(fitCheck({ needBytes: GB, dest: { usedBytes: 0, totalBytes: 0 } }).verdict).toBe('unknown');
  });

  test('needFromUsage: the busiest copy times the copies that move', () => {
    expect(needFromUsage({ memBytes: { peak: 300 } }, 2)).toBe(600);
    expect(needFromUsage({ memBytes: { peak: 300 } }, 0)).toBe(300);
    expect(needFromUsage(null, 1)).toBeNull();
  });

  test('roomiest picks the lowest after among the ones that fit', () => {
    const c = [
      { id: 'a', fit: fitCheck({ needBytes: GB, dest: { usedBytes: 10 * GB, totalBytes: 16 * GB } }) },
      { id: 'b', fit: fitCheck({ needBytes: GB, dest: { usedBytes: 2 * GB, totalBytes: 16 * GB } }) },
      { id: 'c', fit: fitCheck({ needBytes: 15 * GB, dest: { usedBytes: 0, totalBytes: 16 * GB } }) },
    ];
    expect(roomiest(c)?.id).toBe('b');
    expect(roomiest([c[2]!])).toBeNull();
  });
});

describe('move rules', () => {
  const s = (o: Partial<MoveSubject> = {}): MoveSubject => ({
    short: 'postgres',
    system: false,
    mode: 'replicated',
    desired: 1,
    labels: {},
    volumes: ['data_pg'],
    ...o,
  });

  test('a single copy with data can move; the mover’s up-front refusals say why', () => {
    expect(subjectBlock(s(), true)).toBeNull();
    expect(subjectBlock(s({ volumes: undefined }), true)).toBeNull(); // still reading the spec
    expect(subjectBlock(s(), false)).toMatch(/admins and owners/);
    expect(subjectBlock(s({ system: true }), true)).toMatch(/part of swarmy/);
    expect(subjectBlock(s({ labels: { [MOVE_STATE_LABEL]: '{}' } }), true)).toMatch(/already moving/);
    expect(subjectBlock(s({ mode: 'global' }), true)).toMatch(/every server/);
    expect(subjectBlock(s({ labels: { 'swarmy.db.role': 'primary' } }), true)).toMatch(/switch-over/);
    expect(subjectBlock(s({ desired: 3 }), true)).toMatch(/3 copies/);
    expect(subjectBlock(s({ desired: 3, volumes: [] }), true)).toMatch(/nothing to move/); // no data says more than copies
    expect(subjectBlock(s({ desired: 2, labels: { 'swarmy.cache.node': 'abc' } }), true)).toBeNull(); // pinned
    expect(subjectBlock(s({ volumes: [] }), true)).toMatch(/nothing to move/);
  });

  test('targets: not the same server, and only one that takes work', () => {
    const t = (status: 'online' | 'offline' | 'draining' | 'pending') => ({ id: 'b', name: 'wkr-2', status });
    expect(targetBlock('a', t('online'))).toBeNull();
    expect(targetBlock('b', t('online'))).toMatch(/already runs here/);
    expect(targetBlock('a', t('offline'))).toBe('wkr-2 is offline.');
    expect(targetBlock('a', t('draining'))).toBe('wkr-2 is being emptied.');
    expect(targetBlock('a', t('pending'))).toMatch(/isn’t ready/);
  });

  test('moveStep reads the swarmy.move.state label', () => {
    expect(moveStep({ [MOVE_STATE_LABEL]: JSON.stringify({ id: 'm1', step: 'copy-live' }) })).toBe('copy-live');
    expect(moveStep({ [MOVE_STATE_LABEL]: 'nope' })).toBeNull();
    expect(moveStep(undefined)).toBeNull();
  });

  test('movePhase: label → moving; then where the service is decides', () => {
    const base = { step: null, sawLabel: false, onTo: false, fresh: false, elapsedMs: 1_000 };
    expect(movePhase({ ...base, step: 'verify' })).toBe('moving');
    expect(movePhase(base)).toBe('starting');
    expect(movePhase({ ...base, elapsedMs: START_GRACE_MS + 1 })).toBe('not-started');
    expect(movePhase({ ...base, onTo: true })).toBe('done');
    expect(movePhase({ ...base, sawLabel: true })).toBe('moving'); // placement not re-read yet
    expect(movePhase({ ...base, sawLabel: true, fresh: true })).toBe('rolled-back');
  });

  test('volumesFromInspect: named volumes only, no binds or anonymous ones', () => {
    const inspect = {
      Spec: {
        TaskTemplate: {
          ContainerSpec: {
            Mounts: [
              { Type: 'volume', Source: 'data_pg', Target: '/var/lib/postgresql/data' },
              { Type: 'bind', Source: '/etc/hosts', Target: '/etc/hosts' },
              { Type: 'volume', Source: 'a'.repeat(64), Target: '/tmp' },
              { Source: 'data_pg', Target: '/again' },
            ],
          },
        },
      },
    };
    expect(volumesFromInspect(inspect)).toEqual(['data_pg']);
    expect(volumesFromInspect({})).toEqual([]);
    expect(volumesFromInspect(null)).toEqual([]);
  });
});

describe('previewWords', () => {
  const t = (id: string, used: number, block: string | null = null) => ({
    id,
    name: id,
    block,
    fit: fitCheck({ needBytes: 2 * GB, dest: { usedBytes: used * GB, totalBytes: 16 * GB } }),
    disk: null,
  });
  const plan = (targets: ReturnType<typeof t>[], block: string | null = null) => ({
    block,
    checking: false,
    volumes: ['data_pg'],
    needBytes: 2 * GB,
    copies: 1,
    targets,
    best: roomiest(targets.filter((x) => !x.block)),
  });

  test('fits: asks, and says how the mover works (old copy kept)', () => {
    const roomy = t('mgr-2', 4);
    const p = previewWords({ short: 'postgres', from: 'wkr-1', plan: plan([roomy]), target: roomy });
    expect(p).toMatchObject({ tone: 'ok', verdict: 'Fits', title: 'Move postgres to mgr-2?', go: true });
    expect(p.body).toMatch(/old copy stays on wkr-1 for 7 days/);
  });

  test("won't fit names the numbers and the roomiest other server; it can't go ahead", () => {
    const full = t('mgr-1', 13);
    const roomy = t('mgr-2', 4);
    const p = previewWords({ short: 'postgres', from: 'wkr-1', plan: plan([full, roomy]), target: full });
    expect(p).toMatchObject({ tone: 'bad', title: 'mgr-1 would run out of memory', go: false });
    expect(p.body).toBe('postgres uses about 2.0 GB; mgr-1 has 3.0 GB free. Try mgr-2.');
  });

  test('a blocked service or server wins over the fit', () => {
    const roomy = t('mgr-2', 4);
    expect(previewWords({ short: 'nats', from: 'a', plan: plan([roomy], 'nats runs 3 copies…'), target: roomy })).toMatchObject({ verdict: 'Can’t move', go: false });
    const empty = t('wkr-3', 1, 'wkr-3 is being emptied.');
    expect(previewWords({ short: 'x', from: 'a', plan: plan([empty, roomy]), target: empty })).toMatchObject({ title: 'wkr-3 is being emptied.', body: 'Try mgr-2.', go: false });
  });
});
