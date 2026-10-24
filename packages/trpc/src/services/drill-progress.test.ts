import { describe, expect, it } from 'bun:test';
import type { ResilienceDrillProgressView } from '@swarmy/core';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { DrillProgressBus, drillProgressBus, subscribeDrillProgress } from './drill-progress';
import { runBackupVerify } from './resilience.service';
import { seedKvRows } from './swarm-kv.service';

/** Board 16's live "Running · <step>": the drill runner publishes each step as it goes. */

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-drill-progress';

const step = (name: string) => ({ name, status: 'passed' as const, detail: null, durationMs: 5 });

describe('DrillProgressBus — whole-run views, org-scoped, replayable', () => {
  it('publishes the run as each step starts and ends, then lingers a minute once finished', () => {
    let t = 1_000;
    const bus = new DrillProgressBus(() => t);
    const seen: ResilienceDrillProgressView[] = [];
    bus.subscribe('org1', (v) => seen.push(v));
    const run = bus.begin('org1', 'restore', 'shop/main');
    run.start('Create throwaway cluster');
    expect(bus.live('org1')[0]).toMatchObject({ runId: run.runId, current: { name: 'Create throwaway cluster' }, steps: [], status: null });
    run.step(step('Create throwaway cluster'));
    run.finish('passed');
    run.start('ignored after finish');
    expect(seen.map((v) => [v.current?.name ?? null, v.steps.length, v.status])).toEqual([
      [null, 0, null],
      ['Create throwaway cluster', 0, null],
      [null, 1, null],
      [null, 1, 'passed'],
    ]);
    expect(bus.live('org2')).toEqual([]);
    t += 61_000;
    expect(bus.live('org1')).toEqual([]);
  });

  it('a subscriber gets the runs so far, then the live tail, until it leaves', async () => {
    const bus = new DrillProgressBus();
    const run = bus.begin('org1', 'backup-verify', 'offsite');
    run.start('restic check on "offsite"');
    const ac = new AbortController();
    const got: ResilienceDrillProgressView[] = [];
    const reading = (async () => {
      for await (const v of subscribeDrillProgress('org1', ac.signal, bus)) {
        got.push(v);
        if (v.status) ac.abort();
      }
    })();
    await Bun.sleep(1);
    run.step(step('restic check on "offsite"'));
    run.finish('passed');
    await reading;
    expect(got[0]?.current?.name).toBe('restic check on "offsite"');
    expect(got.at(-1)).toMatchObject({ status: 'passed', current: null, steps: [{ name: 'restic check on "offsite"' }] });
  });
});

describe('the drill runner streams its steps', () => {
  it('runBackupVerify shows "restic check" as the current step while it runs', async () => {
    let during: ResilienceDrillProgressView | undefined;
    const hub = {
      managerNode: () => 'n1', isOnline: () => true, onlineNodeIds: () => ['n1'], latestContainers: () => [],
      liveInventory: () => ({ services: [], containers: [] }),
      dispatch: async (_n: string, cmd: string) => {
        if (cmd === 'container.runOnce') {
          during = drillProgressBus.live('org-dp').at(-1);
          return { exitCode: 0, output: 'no errors were found' };
        }
        return {};
      },
    };
    seedKvRows(hub as never, 'org-dp', 'bkp-target', [
      { id: 't1', name: 'offsite', kind: 'S3', endpoint: 'https://s3.example.com', bucket: 'b', prefix: null, region: null, credentialRef: null, secretKeyRef: null, resticPasswordRef: encryptSecret('pw'), enabled: true, createdAt: new Date(0) },
    ]);
    const ctx = { db: { auditLog: { create: async () => ({}) } }, hub, user: { id: 'u1' }, activeOrgId: 'org-dp' } as unknown as OrgContext;
    const result = await runBackupVerify(ctx, { targetId: 't1' });
    expect(result.status).toBe('passed');
    expect(during).toMatchObject({ kind: 'backup-verify', target: 'offsite', current: { name: 'restic check on "offsite"' }, status: null });
    expect(drillProgressBus.live('org-dp').at(-1)).toMatchObject({ status: 'passed', current: null, steps: [{ status: 'passed' }] });
  });
});
