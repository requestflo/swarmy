import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { buildStageBus } from './build-stage-bus';
import { followBuilderStages, timeStage, type StageDb } from './build-stages.service';
import { rollOutBuilds, watchRollout } from './build-rollout.service';

interface Row { buildId: string; stage: string; startedAt: Date; finishedAt: Date | null; outcome: string; factsJson?: unknown }

/** An in-memory `buildStage` table (upsert / updateMany are all the service uses). */
function fakeDb(): { db: StageDb; rows: Row[]; releases: Record<string, string> } {
  const rows: Row[] = [];
  const releases: Record<string, string> = {};
  const match = (r: Row, w: Record<string, unknown>) => Object.entries(w).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v);
  const buildStage = {
    async upsert(a: { where: { buildId_stage: { buildId: string; stage: string } }; create: Pick<Row, 'buildId' | 'stage' | 'startedAt'>; update: Partial<Row> }) {
      const hit = rows.find((r) => match(r, a.where.buildId_stage));
      if (hit) Object.assign(hit, a.update);
      else rows.push({ finishedAt: null, outcome: 'running', ...a.create });
    },
    async updateMany(a: { where: Record<string, unknown>; data: Partial<Row> }) {
      for (const r of rows.filter((x) => match(x, a.where))) Object.assign(r, a.data);
    },
  };
  const build = {
    async updateMany(a: { where: { id: { in: string[] } }; data: { releaseId: string } }) {
      for (const id of a.where.id.in) releases[id] = a.data.releaseId;
    },
  };
  return { db: { buildStage, build } as unknown as StageDb, rows, releases };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const at = (s: number) => new Date(Date.parse('2026-10-24T10:42:00Z') + s * 1000);

describe('followBuilderStages', () => {
  it('times clone → build → push from the chosen builder only, closing each as the next begins', async () => {
    const { db, rows } = fakeDb();
    const f = followBuilderStages(db, { buildId: 'b1', commandId: 'cmd-1', nodeId: 'n1' });
    buildStageBus.emit('cmd-1', { nodeId: 'n1', stage: 'clone', at: at(0) });
    buildStageBus.emit('cmd-1', { nodeId: 'evil', stage: 'push', at: at(1) }); // another node: ignored
    buildStageBus.emit('cmd-1', { nodeId: 'n1', stage: 'build', at: at(2) });
    buildStageBus.emit('cmd-1', { nodeId: 'n1', stage: 'push', at: at(40) });
    await f.settle('ok');
    expect(rows.map((r) => [r.stage, r.startedAt, r.outcome])).toEqual([
      ['clone', at(0), 'ok'],
      ['build', at(2), 'ok'],
      ['push', at(40), 'ok'],
    ]);
    expect(rows[0]?.finishedAt).toEqual(at(2));
    expect(rows[1]?.finishedAt).toEqual(at(40));
    // Unsubscribed: a late frame changes nothing.
    buildStageBus.emit('cmd-1', { nodeId: 'n1', stage: 'clone', at: at(99) });
    await tick();
    expect(rows).toHaveLength(3);
  });

  it('marks the stage the build died in as failed, with the first error line', async () => {
    const { db, rows } = fakeDb();
    const f = followBuilderStages(db, { buildId: 'b2', commandId: 'cmd-2', nodeId: 'n1' });
    buildStageBus.emit('cmd-2', { nodeId: 'n1', stage: 'clone', at: at(0) });
    buildStageBus.emit('cmd-2', { nodeId: 'n1', stage: 'build', at: at(2) });
    await f.settle('failed', new Error('build exited 1\n#7 ERROR: tail'));
    expect(rows[1]).toMatchObject({ stage: 'build', outcome: 'failed', factsJson: { error: 'build exited 1' } });
  });

  it('records nothing for an older agent that reports no stages', async () => {
    const { db, rows } = fakeDb();
    await followBuilderStages(db, { buildId: 'b3', commandId: 'cmd-3', nodeId: 'n1' }).settle('ok');
    expect(rows).toEqual([]);
  });
});

describe('timeStage', () => {
  it('judges the result, rethrows a failure, and skips the history without a build', async () => {
    const { db, rows } = fakeDb();
    await timeStage(db, 'b1', 'scan', async () => 7, () => ({ outcome: 'warn', facts: { scan: { critical: 0, high: 1, medium: 0, low: 0 } } }));
    await expect(timeStage(db, 'b1', 'sign', async () => Promise.reject(new Error('cosign sign exited 1')))).rejects.toThrow('cosign');
    expect(await timeStage(db, undefined, 'scan', async () => 'ran')).toBe('ran');
    expect(rows.map((r) => [r.stage, r.outcome])).toEqual([['scan', 'warn'], ['sign', 'failed']]);
  });
});

describe('rollout', () => {
  const DIGEST = `sha256:${'ab'.repeat(32)}`;
  const image = `localhost:5000/shop@${DIGEST}`;
  const ctxWith = (db: StageDb, services: unknown[]) =>
    ({ db, activeOrgId: 'org1', hub: { liveInventory: () => ({ services, containers: [] }) } }) as unknown as OrgContext;

  it('links the release to the builds the compose deploys and fails the stage when the deploy throws', async () => {
    const { db, rows, releases } = fakeDb();
    const ctx = ctxWith(db, []);
    const compose = `services:\n  web:\n    image: ${image}\n`;
    const builds = [{ id: 'b1', image }, { id: 'b-other', image: 'localhost:5000/x@sha256:ffff' }];
    await rollOutBuilds(ctx, { stack: 'shop', builds, composeSource: compose }, async () => ({ releaseId: 'rel1' }));
    expect(releases).toEqual({ b1: 'rel1' });
    expect(rows.map((r) => [r.buildId, r.stage])).toEqual([['b1', 'rollout']]);
    await expect(
      rollOutBuilds(ctx, { stack: 'shop', builds, composeSource: compose }, async () => Promise.reject(new Error('admission blocked'))),
    ).rejects.toThrow('admission');
    expect(rows[0]).toMatchObject({ outcome: 'failed', factsJson: { error: 'admission blocked' } });
  });

  it('the watch settles ok once every copy runs the digest', async () => {
    const { db, rows } = fakeDb();
    rows.push({ buildId: 'b9', stage: 'rollout', startedAt: at(0), finishedAt: null, outcome: 'running' });
    const live = [{ name: 'shop_web', image, desiredReplicas: 2, runningReplicas: 2, updateStatus: 'completed', labels: { 'com.docker.stack.namespace': 'shop' } }];
    await watchRollout(ctxWith(db, live), 'shop', { id: 'b9', image }, { sleep: async () => undefined });
    expect(rows[0]).toMatchObject({ outcome: 'ok', factsJson: { rollout: { services: ['web'], ready: 2, desired: 2, drained: true } } });
  });

  it('the watch gives up (failed) when the digest never runs', async () => {
    const { db, rows } = fakeDb();
    rows.push({ buildId: 'b8', stage: 'rollout', startedAt: at(0), finishedAt: null, outcome: 'running' });
    let t = 0;
    await watchRollout(ctxWith(db, []), 'shop', { id: 'b8', image }, { now: () => (t += 1_000), sleep: async () => undefined, watchMs: 5_000 });
    expect(rows[0]?.outcome).toBe('failed');
  });
});
