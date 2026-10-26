import { describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { DbRestoreProgressView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { restoreDb } from './dbBackup.service';
import { RestoreProgressRelay, restoreProgress } from './restore-progress';
import { seedKvRows } from './swarm-kv.service';

/**
 * A restore's steps are run state, never stored: the relay keeps the latest
 * run per source cluster, the agent's frames fill in the numbers, and a
 * finished run lingers a minute. `restoreDb` drives it: the safety copy,
 * then the download with the agent's progress.
 */

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-restore-progress';

describe('RestoreProgressRelay', () => {
  function rig() {
    let t = 1_000;
    const relay = new RestoreProgressRelay(() => t);
    const run = relay.begin('org1', 'shop/main', { into: 'shop/main', mode: 'pitr', engine: 'wal-g', targetTime: '2026-10-24T13:10:00Z' });
    return { relay, run, tick: (ms: number) => (t += ms), view: () => relay.latest('org1', 'shop/main') as DbRestoreProgressView };
  }

  it('moves through steps; the agent\'s frames set the step and its numbers, which reset on the next step', () => {
    const { run, tick, view } = rig();
    run.stage('safety');
    tick(500);
    run.stage('stop');
    run.agent({ phase: 'restoring', restore: { stage: 'base', bytesDone: 10, bytesTotal: 40 } });
    expect(view()).toMatchObject({ current: { stage: 'base' }, bytesDone: 10, bytesTotal: 40, status: 'running' });
    run.agent({ phase: 'restoring', restore: { stage: 'wal', segments: 16 } });
    expect(view()).toMatchObject({ current: { stage: 'wal' }, bytesDone: null, segments: 16 });
    run.stage('replay');
    run.replay('2026-10-24T13:05:22.000Z');
    expect(view().done.map((d) => d.stage)).toEqual(['safety', 'stop', 'base', 'wal']);
    expect(view().done[0]).toEqual({ stage: 'safety', startedAt: 1_000, endedAt: 1_500 });
    expect(view().replayedTo).toBe('2026-10-24T13:05:22.000Z');
  });

  it('a deploy pull frame (or one with no restore detail) changes nothing', () => {
    const { run, view } = rig();
    run.stage('download');
    run.agent({ phase: 'pulling', message: 'pulling' });
    run.agent({ phase: 'restoring' });
    expect(view()).toMatchObject({ current: { stage: 'download' }, bytesDone: null });
  });

  it('success closes the last step; failure keeps it as the one that failed; later calls are ignored', () => {
    const ok = rig();
    ok.run.stage('check');
    ok.run.finish(true);
    ok.run.stage('stop');
    expect(ok.view()).toMatchObject({ status: 'succeeded', current: null, error: null });
    expect(ok.view().done.map((d) => d.stage)).toEqual(['check']);
    const bad = rig();
    bad.run.stage('base');
    bad.run.finish(false, 'wal-g backup-fetch exited 1');
    expect(bad.view()).toMatchObject({ status: 'failed', current: { stage: 'base' }, error: 'wal-g backup-fetch exited 1' });
  });

  it('a finished run lingers a minute, then is gone; other orgs never see it', () => {
    const { relay, run, tick } = rig();
    run.finish(true);
    tick(59_000);
    expect(relay.latest('org1', 'shop/main')).not.toBeNull();
    expect(relay.latest('org2', 'shop/main')).toBeNull();
    tick(2_000);
    expect(relay.latest('org1', 'shop/main')).toBeNull();
  });
});

const SCHEDULE = JSON.stringify({ cron: '0 3 * * *', engine: 'pg_dump', retentionDays: 7, targetId: 'tgt-1' });

describe('restoreDb reports its steps', () => {
  it('in place: the safety copy, then the download with the agent\'s numbers, then done', async () => {
    const orgId = 'org-rp-1';
    const seen: Array<DbRestoreProgressView | null> = [];
    const primary = {
      id: 'svc-main', name: 'shop_main-primary', image: 'pgvector/pgvector:pg17', mode: 'replicated' as const,
      desiredReplicas: 1, runningReplicas: 1,
      labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'main', 'swarmy.db.role': 'primary', 'swarmy.db.backup.schedule': SCHEDULE },
      env: ['POSTGRES_PASSWORD=pw', 'POSTGRES_DB=app'], networks: [], ports: [],
    };
    const payloads: Record<string, unknown>[] = [];
    const hub = {
      managerNode: () => 'n1', isOnline: () => true, onlineNodeIds: () => ['n1'], latestContainers: () => [], swarmNodeIdFor: () => undefined,
      liveInventory: () => ({ services: [primary], containers: [] }),
      dispatch: async (_n: string, cmd: string, payload: Record<string, unknown>, opts?: { onProgress?: (p: unknown) => void }) => {
        if (cmd === 'db.backup') {
          seen.push(restoreProgress.latest(orgId, 'shop/main'));
          return { snapshotId: 'safe1', engine: payload.engine, sizeBytes: 10, databases: ['app'] };
        }
        if (cmd === 'db.restore') {
          payloads.push(payload);
          opts?.onProgress?.({ phase: 'restoring', restore: { stage: 'download', bytesDone: 5, bytesTotal: 10, percent: 50 } });
          seen.push(restoreProgress.latest(orgId, 'shop/main'));
          return { mode: 'in-place', engine: 'pg_dump', bytesRestored: 10 };
        }
        return {};
      },
    };
    seedKvRows(hub as never, orgId, 'bkp-target', [
      { id: 'tgt-1', name: 'offsite', kind: 'S3', endpoint: 'https://s3.example.com', bucket: 'b', prefix: 'p', region: null, credentialRef: null, secretKeyRef: null, resticPasswordRef: encryptSecret('pw'), enabled: true },
    ]);
    const ctx = { db: { auditLog: { create: async () => ({}) } }, hub, user: { id: 'u1' }, activeOrgId: orgId, session: null, reqHeaders: new Headers() } as unknown as OrgContext;

    await restoreDb(ctx, { stack: 'shop', cluster: 'main', engine: 'pg_dump', mode: 'in-place', snapshotId: 'abc123' });
    expect(seen[0]).toMatchObject({ current: { stage: 'safety' }, into: 'shop/main', mode: 'in-place', status: 'running' });
    expect(seen[1]).toMatchObject({ current: { stage: 'download' }, bytesDone: 5, bytesTotal: 10, percent: 50 });
    expect(payloads[0]!.reportProgress).toBe(true);
    const end = restoreProgress.latest(orgId, 'shop/main')!;
    expect(end.status).toBe('succeeded');
    expect(end.done.map((d) => d.stage)).toEqual(['safety', 'download']);
  });
});
