import { describe, expect, test } from 'bun:test';
import { durationWords, outcomeLine, stageRows, type BuildLike, type StageLike } from './build-stage-model';

const t0 = Date.parse('2026-10-24T10:42:01Z');
const at = (s: number): string => new Date(t0 + s * 1000).toISOString();
const stage = (key: StageLike['key'], from: number, to: number | null, over: Partial<StageLike> = {}): StageLike => ({
  key,
  startedAt: at(from),
  finishedAt: to === null ? null : at(to),
  outcome: to === null ? 'running' : 'ok',
  facts: {},
  ...over,
});
const base: BuildLike = {
  status: 'succeeded',
  repoUrl: 'https://github.com/northwind/storefront.git',
  commit: '4e1c09a7f2b3c4d5e6f708192a3b4c5d6e7f8091',
  image: 'localhost:5000/northwind-storefront@sha256:4e1c09a7',
  startedAt: at(0),
  builder: 'dockerfile',
  cachedSteps: 5,
  stages: [],
  usualMs: { clone: 2_000, build: 41_000 },
};
const rollout = { stack: 'storefront', services: ['checkout'], ready: 3, desired: 3, drained: true };

describe('durationWords', () => {
  test('seconds, then minutes with padded seconds', () => {
    expect(durationWords(1_800)).toBe('2 s');
    expect(durationWords(38_000)).toBe('38 s');
    expect(durationWords(64_000)).toBe('1 m 04 s');
  });
});

describe('stageRows', () => {
  test('a running build: what ran, the stage it is on, and the ones still to come', () => {
    const b: BuildLike = { ...base, status: 'building', stages: [stage('clone', 0, 2), stage('build', 2, null)] };
    const rows = stageRows(b, t0 + 33_000);
    expect(rows.map((r) => [r.key, r.state, r.time])).toEqual([
      ['clone', 'done', '2 s · usually 2 s'],
      ['build', 'running', '31 s · usually 41 s'],
      ['push', 'pending', '—'],
      ['scan', 'pending', '—'],
    ]);
    expect(rows[0]?.detail).toBe('github.com/northwind/storefront @ 4e1c09a');
    expect(rows[1]?.detail).toBe('Dockerfile · 5 steps from cache');
  });

  test('a finished build shows only what was timed; sign and roll out only once they happened', () => {
    const scan = stage('scan', 42, 49, { outcome: 'warn', facts: { scan: { critical: 0, high: 1, medium: 2, low: 5 } } });
    const rows = stageRows({ ...base, stages: [stage('clone', 0, 2), stage('build', 2, 40), stage('push', 40, 42), scan] }, t0);
    expect(rows.map((r) => r.key)).toEqual(['clone', 'build', 'push', 'scan']);
    expect(rows[3]).toMatchObject({ tone: 'warn', state: 'done', detail: '0 critical · 1 high · 2 medium · 5 low' });
    expect(rows[2]?.detail).toBe('localhost:5000 · in your swarm');
  });

  test('a failed stage says why; an older build with no stages has no rail', () => {
    const failed = stage('build', 2, 9, { outcome: 'failed', facts: { error: 'build exited 1' } });
    expect(stageRows({ ...base, status: 'failed', stages: [stage('clone', 0, 2), failed] }, t0)[1]).toMatchObject({ tone: 'bad', detail: 'build exited 1' });
    expect(stageRows({ ...base, status: 'building' }, t0)).toEqual([]);
  });
});

describe('outcomeLine', () => {
  test('live: commit, where, total from the first stage, health, drained', () => {
    const b = { ...base, stages: [stage('clone', 0, 2), stage('rollout', 54, 64, { facts: { rollout } })] };
    expect(outcomeLine(b)).toEqual({
      tone: 'ok',
      title: '4e1c09a is live on checkout',
      meta: '1 m 04 s total · health 3/3 · previous copy drained',
      stack: 'storefront',
    });
  });

  test('only what is real: no drained claim on a first deploy; nothing while it rolls', () => {
    const first = { ...base, commit: 'main', stages: [stage('rollout', 54, 64, { facts: { rollout: { ...rollout, drained: undefined } } })] };
    expect(outcomeLine(first)?.title).toBe('This build is live on checkout');
    expect(outcomeLine(first)?.meta).toBe('1 m 04 s total · health 3/3');
    expect(outcomeLine({ ...base, stages: [stage('rollout', 54, null)] })).toBeNull();
    expect(outcomeLine(base)).toBeNull();
  });

  test('a failed rollout says so, with or without the swarm facts', () => {
    const rolledBack = stage('rollout', 54, 70, { outcome: 'failed', facts: { error: 'Docker put the previous copy back', rollout: { ...rollout, ready: 1 } } });
    expect(outcomeLine({ ...base, stages: [rolledBack] })).toMatchObject({ tone: 'bad', title: '4e1c09a didn’t roll out on checkout', meta: 'Docker put the previous copy back · health 1/3' });
    const blocked = stage('rollout', 54, 55, { outcome: 'failed', facts: { error: 'admission blocked' } });
    expect(outcomeLine({ ...base, stages: [blocked] })).toEqual({ tone: 'bad', title: '4e1c09a didn’t roll out', meta: 'admission blocked', stack: null });
  });
});
