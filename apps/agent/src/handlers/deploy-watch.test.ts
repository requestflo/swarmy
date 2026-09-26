import { describe, expect, test } from 'bun:test';
import type { PullProgressEvent } from '@swarmy/core/docker';
import type { DeployProgressPayload } from '@swarmy/core/protocol';
import { displayImage, watchDeploy, type DeployWatchDeps, type WatchTask } from './deploy-watch';
import { desiredOf, toWatchTasks } from './deploy-watch-run';
import { foldLayerEvent, layerSummary, newLayerTally, pullProgressLine, shortDigest } from './deploy-layers';

const DIGEST = `sha256:4be1${'0'.repeat(56)}c07a`;
const watch = { deployId: 'dep_k2x9q7ab', stack: 'blog', role: 'main' as const };

/** A scripted swarm: each poll returns the next task list (the last one repeats). */
function fake(script: WatchTask[][], o: { local?: string; pullEvents?: PullProgressEvent[]; pullFails?: boolean } = {}) {
  let clock = 1_000_000;
  let poll = 0;
  const sent: DeployProgressPayload[] = [];
  const pulls: string[] = [];
  const deps: DeployWatchDeps = {
    tasks: async () => script[Math.min(poll++, script.length - 1)] ?? [],
    localNodeId: async () => o.local ?? 'swarm-a',
    nodeName: async (id) => (id === 'swarm-a' ? 'london-1' : 'worker-2'),
    pull: async (image, onEvent) => {
      pulls.push(image);
      if (o.pullFails) throw new Error('denied');
      for (const e of o.pullEvents ?? []) {
        clock += 600; // past the 500 ms throttle each time
        onEvent(e);
      }
      return DIGEST;
    },
    send: (p) => sent.push(p),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await Promise.resolve();
    },
  };
  return { deps, sent, pulls, at: () => clock };
}

const task = (state: string, over: Partial<WatchTask> = {}): WatchTask => ({ nodeId: 'swarm-a', state, desired: 'running', createdAt: 1_000_000, ...over });
const lines = (sent: DeployProgressPayload[]) => sent.map((s) => `${s.stage}:${s.status} ${s.message}`);

describe('deploy layer accounting', () => {
  test('counts layers, bytes and "already exists" from the pull stream', () => {
    const t = newLayerTally();
    for (const e of [
      { id: '5.96-alpine', status: 'Pulling from library/ghost' },
      { id: 'a', status: 'Pulling fs layer' },
      { id: 'b', status: 'Already exists' },
      { id: 'a', status: 'Downloading', progressDetail: { current: 40_000_000, total: 100_000_000 } },
    ] as PullProgressEvent[])
      foldLayerEvent(t, e);
    expect(layerSummary(t)).toEqual({ layersTotal: 2, layersDone: 1, bytesTotal: 100_000_000, bytesDone: 40_000_000 });
    foldLayerEvent(t, { id: 'a', status: 'Pull complete' });
    expect(layerSummary(t)).toEqual({ layersTotal: 2, layersDone: 2, bytesTotal: 100_000_000, bytesDone: 100_000_000 });
    expect(pullProgressLine('ghost:5.96-alpine', layerSummary(t))).toBe('ghost:5.96-alpine: 2 of 2 layers · 100 MB of 100 MB');
  });

  test('short digest and display image never show the registry pin', () => {
    expect(shortDigest(DIGEST)).toBe('sha256:4be1…c07a');
    expect(displayImage('localhost:5000/acme/ghost:5.96-alpine@sha256:abc')).toBe('ghost:5.96-alpine');
  });
});

describe('watchDeploy', () => {
  test('main service on this node: pull started → layer progress → digest verified → starting → running', async () => {
    const f = fake([[task('preparing')], [task('starting')], [task('running')]], {
      pullEvents: [
        { id: 'a', status: 'Pulling fs layer' },
        { id: 'a', status: 'Downloading', progressDetail: { current: 1_000_000, total: 2_000_000 } },
        { id: 'a', status: 'Pull complete' },
      ],
    });
    await watchDeploy(f.deps, { watch, service: 'blog_ghost', image: 'ghost:5.96-alpine', desired: 1, volumes: [] });
    await Promise.resolve();
    const l = lines(f.sent);
    expect(l[0]).toBe('pull:started pulling ghost:5.96-alpine on london-1');
    expect(l).toContain('pull:progress ghost:5.96-alpine: 0 of 1 layers · 1 MB of 2 MB');
    expect(l).toContain('pull:done digest sha256:4be1…c07a verified');
    expect(l).toContain('start:started blog_ghost 0/1 → starting');
    expect(l[l.length - 1]).toBe('start:done blog_ghost 1/1 running');
    const done = f.sent.find((s) => s.stage === 'pull' && s.status === 'done');
    expect(done?.detail?.digest).toBe(DIGEST);
    expect(f.sent.every((s) => s.deployId === 'dep_k2x9q7ab' && s.node === 'london-1')).toBe(true);
  });

  test('task on another node: no local pull, the task state says when the image is there', async () => {
    const f = fake([[task('preparing', { nodeId: 'swarm-b' })], [task('running', { nodeId: 'swarm-b' })]]);
    await watchDeploy(f.deps, { watch, service: 'blog_ghost', image: 'ghost:5', desired: 1, volumes: [] });
    expect(f.pulls).toEqual([]);
    expect(lines(f.sent)).toEqual([
      'pull:started pulling ghost:5 on worker-2',
      'pull:done ghost:5 is on worker-2',
      'start:started blog_ghost 1/1 → starting',
      'start:done blog_ghost 1/1 running',
    ]);
  });

  test('a companion folds into the data stage and reports its volume', async () => {
    const f = fake([[task('starting')], [task('running')]]);
    await watchDeploy(f.deps, { watch: { ...watch, role: 'data' }, service: 'blog_db', image: 'mysql:8.4', desired: 1, volumes: ['blog_db-data'] });
    expect(f.pulls).toEqual([]);
    expect(f.sent.every((s) => s.stage === 'data')).toBe(true);
    expect(lines(f.sent)).toEqual([
      'data:started blog_db 0/1 → scheduling',
      'data:progress pulling mysql:8.4 on london-1',
      'data:progress mysql:8.4 is on london-1',
      'data:progress blog_db 0/1 → starting',
      'data:progress volume blog_db-data mounted on london-1',
      'data:done blog_db 1/1 running',
    ]);
  });

  test('a rejected task is reported once as failed, then running still finishes it', async () => {
    const bad = task('rejected', { desired: 'shutdown', err: 'No such image: ghost:nope' });
    const f = fake([[bad], [bad], [bad, task('running')]], { pullFails: true });
    await watchDeploy(f.deps, { watch, service: 'blog_ghost', image: 'ghost:nope', desired: 1, volumes: [] });
    const failed = f.sent.filter((s) => s.status === 'failed');
    expect(failed.map((s) => `${s.stage} ${s.message}`)).toEqual(['pull blog_ghost: No such image: ghost:nope']);
    expect(f.sent[f.sent.length - 1]?.message).toBe('blog_ghost 1/1 running');
  });

  test('an unchanged redeploy (no new tasks) settles as running · unchanged', async () => {
    const old = task('running', { createdAt: 1 });
    const f = fake([[old]]);
    await watchDeploy(f.deps, { watch, service: 'blog_ghost', image: 'ghost:5', desired: 1, volumes: [] }, { settleMs: 3_000 });
    expect(lines(f.sent)).toEqual(['start:done blog_ghost 1/1 running · unchanged']);
  });

  test('gives up quietly after the bound (never throws, never blocks)', async () => {
    const f = fake([[task('pending')]]);
    await watchDeploy(f.deps, { watch, service: 'blog_ghost', image: 'ghost:5', desired: 1, volumes: [] }, { maxMs: 5_000 });
    expect(f.sent).toEqual([]);
    expect(f.at()).toBeGreaterThanOrEqual(1_005_000);
  });

  test('messages carry no env or credentials (only image, names, counts)', async () => {
    const f = fake([[task('running')]]);
    await watchDeploy(f.deps, { watch, service: 'blog_ghost', image: 'ghost:5', desired: 1, volumes: [] });
    expect(JSON.stringify(f.sent)).not.toMatch(/password|token|secret/i);
  });
});

describe('docker task mapping', () => {
  test('toWatchTasks reads node, state, desired, created and the error line', () => {
    expect(
      toWatchTasks([{ NodeID: 'n1', DesiredState: 'running', CreatedAt: '2026-09-26T10:40:02Z', Status: { State: 'preparing' } }, { Status: { State: 'rejected', Err: 'boom' } }]),
    ).toEqual([
      { nodeId: 'n1', state: 'preparing', desired: 'running', createdAt: Date.parse('2026-09-26T10:40:02Z') },
      { nodeId: '', state: 'rejected', desired: '', createdAt: 0, err: 'boom' },
    ]);
  });

  test('desiredOf: replicated count, default 1, global = null', () => {
    expect(desiredOf({ mode: { replicated: { replicas: 3 } } })).toBe(3);
    expect(desiredOf({})).toBe(1);
    expect(desiredOf({ mode: { global: {} } })).toBeNull();
  });
});
