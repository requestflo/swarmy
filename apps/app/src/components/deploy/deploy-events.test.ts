import { describe, expect, test } from 'bun:test';
import type { DeployStep } from './deploy-steps';
import { eventServer, foldStages, layersLine, mergeSteps, shortDigest, type DeployEvent } from './deploy-events';

const T0 = 1_000_000;
let seq = 0;
const ev = (sec: number, stage: DeployEvent['stage'], status: DeployEvent['status'], o: Partial<DeployEvent> = {}): DeployEvent => ({
  deployId: 'dep_k2x9q7ab',
  stack: 'blog',
  node: 'london-1',
  stage,
  status,
  at: T0 + sec * 1000,
  message: `${stage} ${status}`,
  seq: ++seq,
  ...o,
});
const step = (key: DeployStep['key'], state: DeployStep['state']): DeployStep => ({ key, title: key, sub: '', state, tech: null });
const polled = [step('image', 'working'), step('data', 'waiting'), step('start', 'waiting'), step('https', 'waiting'), step('health', 'waiting')];

describe('foldStages', () => {
  test('a stage is done when every key it covers is done; times are from the deploy start', () => {
    const f = foldStages(
      [
        ev(1, 'data', 'started', { service: 'blog_db' }),
        ev(1, 'data', 'started', { service: 'step:0', node: 'swarmy' }),
        ev(2, 'data', 'done', { service: 'step:0', node: 'swarmy' }),
        ev(2, 'pull', 'started'),
        ev(9, 'data', 'done', { service: 'blog_db' }),
        ev(12, 'pull', 'done', { detail: { layersTotal: 7, bytesTotal: 142_000_000, digest: `sha256:4be1${'0'.repeat(56)}c07a` } }),
      ],
      T0,
    );
    expect(f.data).toMatchObject({ state: 'done', startedSec: 1, doneSec: 9 });
    expect(f.image).toMatchObject({ state: 'done', startedSec: 2, doneSec: 12 });
    expect(layersLine(f.image!.detail)).toBe('7 layers · 142 MB');
    expect(f.start).toBeUndefined();
  });

  test('any failed key fails the stage; a started one keeps it working', () => {
    expect(foldStages([ev(1, 'start', 'started'), ev(3, 'start', 'failed')], T0).start?.state).toBe('failed');
    expect(foldStages([ev(1, 'data', 'started', { service: 'a' }), ev(2, 'data', 'done', { service: 'b' })], T0).data?.state).toBe('working');
  });
});

describe('mergeSteps', () => {
  test('events win where they speak, polling stands in elsewhere, image gets layers + digest facts', () => {
    const folds = foldStages([ev(1, 'pull', 'done', { detail: { layersTotal: 3, digest: `sha256:ab12${'0'.repeat(56)}cd34` } })], T0);
    const out = mergeSteps(polled, folds, false);
    expect(out[0]).toMatchObject({ state: 'done', facts: ['3 layers', 'digest sha256:ab12…cd34'] });
    expect(out[1]!.state).toBe('waiting');
  });

  test('a quiet stream lets polling finish a step the events still call working', () => {
    const folds = foldStages([ev(1, 'start', 'started')], T0);
    const p = polled.map((s) => (s.key === 'start' ? { ...s, state: 'done' as const } : s));
    expect(mergeSteps(p, folds, true)[2]!.state).toBe('done');
    expect(mergeSteps(p, folds, false)[2]!.state).toBe('working');
  });
});

describe('helpers', () => {
  test('eventServer is the latest real node, never the controller', () => {
    expect(eventServer([ev(1, 'pull', 'started'), ev(2, 'route', 'started', { node: 'swarmy' })])).toBe('london-1');
    expect(eventServer([ev(1, 'route', 'started', { node: 'swarmy' })])).toBeNull();
  });
  test('shortDigest', () => {
    expect(shortDigest(`sha256:4be1${'0'.repeat(56)}c07a`)).toBe('sha256:4be1…c07a');
  });
});
