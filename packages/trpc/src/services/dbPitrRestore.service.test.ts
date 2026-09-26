import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import {
  IN_RECOVERY_SCRIPT,
  PITR_VERIFY_SCRIPT,
  errorTail,
  pitrCleanupScript,
  pitrStamp,
  runPitrRestore,
  type PitrRestorePlan,
} from './dbPitrRestore.service';

/**
 * QA-087: the PITR restore sequence against an in-memory hub. The target is
 * stopped before the agent touches its volume. No password is read from a
 * running member. After the restore it is started, waited on until it
 * promotes, cleaned, given its own password and verified, and a restore that
 * never recovers is rolled back to the kept PGDATA.
 */

const SERVICE = 'qa-data_pitrcopy-primary';
const PRIMARY: SwarmServiceInfo = {
  id: 'svc-pitrcopy',
  name: SERVICE,
  image: 'pgvector/pgvector:pg17',
  mode: 'replicated',
  desiredReplicas: 1,
  runningReplicas: 1,
  createdAt: 0,
  updatedAt: 0,
  labels: { 'com.docker.stack.namespace': 'qa-data', 'swarmy.db.cluster': 'pitrcopy', 'swarmy.db.role': 'primary' },
  networks: [],
  env: [],
  ports: [],
  secrets: [],
  configs: [],
} as unknown as SwarmServiceInfo;

interface WorldOpts {
  /** Ticks the server stays in recovery before promoting (Infinity = never). */
  recoveryTicks?: number;
  /** The agent's db.restore throws this. */
  restoreError?: string;
  /** Each poll gets a fresh container (the server crash-loops). */
  crashLoop?: boolean;
  /** The service ignores scale 0. */
  neverStops?: boolean;
}

function world(opts: WorldOpts = {}) {
  const log: string[] = [];
  const dispatched: Array<{ node: string; cmd: string; payload: Record<string, unknown> }> = [];
  const audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
  let running = true;
  let generation = 1;
  let recoveryLeft = opts.recoveryTicks ?? 1;
  const containers = () =>
    running
      ? [{ id: `c${generation}`, serviceId: PRIMARY.id, state: 'running', labels: {}, name: `${SERVICE}.1`, image: PRIMARY.image, createdAt: generation }]
      : [];
  const hub = {
    managerNode: () => 'n-mgr',
    isOnline: () => true,
    onlineNodeIds: () => ['n-data'],
    latestContainers: () => containers(),
    liveInventory: () => ({ services: [PRIMARY], containers: containers() }),
    dispatch: async (node: string, cmd: string, payload: Record<string, unknown>) => {
      dispatched.push({ node, cmd, payload });
      if (cmd === 'service.scale') {
        log.push(`scale ${payload.replicas}`);
        if (payload.replicas === 0) {
          if (!opts.neverStops) running = false;
        } else {
          running = true;
          generation += 1;
        }
        return {};
      }
      if (cmd === 'db.restore') {
        log.push(`db.restore ${payload.pitrAction}${running ? ' WHILE RUNNING' : ''}`);
        if (payload.pitrAction === 'restore' && opts.restoreError) throw new Error(opts.restoreError);
        return {
          mode: 'pitr',
          engine: 'wal-g',
          bytesRestored: 0,
          recoveredTo: payload.targetTime,
          backupName: 'base_000000010000000000000002',
          asidePath: '/var/lib/postgresql/data/pgdata.pre-pitr-s1',
        };
      }
      if (cmd === 'exec') {
        const script = (payload.cmd as string[])[2]!;
        if (script === IN_RECOVERY_SCRIPT) {
          log.push('exec in-recovery?');
          if (opts.crashLoop) generation += 1;
          if (recoveryLeft > 0) {
            recoveryLeft -= 1;
            return { exitCode: 0, output: 't\n' };
          }
          return { exitCode: 0, output: 'f\n' };
        }
        if (script === pitrCleanupScript()) log.push('exec cleanup');
        else if (script.includes('ALTER ROLE')) log.push('exec roles');
        else if (script === PITR_VERIFY_SCRIPT) log.push('exec verify');
        else log.push('exec ?');
        return { exitCode: 0, output: script === PITR_VERIFY_SCRIPT ? '1\n' : '' };
      }
      return {};
    },
  };
  const db = {
    auditLog: {
      create: async (a: { data: { action: string; metadata: Record<string, unknown> } }) => {
        audits.push({ action: a.data.action, metadata: a.data.metadata });
        return {};
      },
    },
  };
  const ctx = { db, hub, user: { id: 'u1' }, activeOrgId: 'org1', session: null, reqHeaders: new Headers() } as unknown as OrgContext;
  return { ctx, log, dispatched, audits };
}

const plan: PitrRestorePlan = {
  targetRef: 'qa-data/pitrcopy',
  service: SERVICE,
  desiredReplicas: 1,
  passwordSecret: 'qa-data_pitrcopy-pg-password__v1',
  replicationUser: 'repl',
  nodeId: 'n-data',
  dataVolume: 'qa-data_pitrcopy-primary-data',
  engine: 'wal-g',
  snapshotId: 'latest',
  targetTime: '2026-09-26T10:00:00Z',
  repo: { kind: 's3', repo: 's3:http://swarmy-garage:3900/bkt/pfx', password: 'rp' },
  tags: [],
  network: 'qa-data_pitrcopy-net',
  resticNetwork: 'swarmy',
  targetId: 't1',
};
const fast = { sleep: async () => undefined, pollMs: 0, stamp: 's1' };

describe('runPitrRestore: the happy path, in order', () => {
  it('stops, restores on the data node, starts, waits for promotion, cleans, resets roles, verifies, audits', async () => {
    const w = world({ recoveryTicks: 2 });
    const view = await runPitrRestore(w.ctx, plan, fast);
    expect(w.log).toEqual([
      'scale 0',
      'db.restore restore',
      'scale 1',
      'exec in-recovery?',
      'exec in-recovery?',
      'exec in-recovery?',
      'exec cleanup',
      'exec roles',
      'exec verify',
    ]);
    expect(view).toEqual({
      mode: 'pitr',
      engine: 'wal-g',
      bytesRestored: '0',
      recoveredTo: '2026-09-26T10:00:00Z',
      backupName: 'base_000000010000000000000002',
      keptAt: '/var/lib/postgresql/data/pgdata.pre-pitr-s1',
    });
    const restore = w.dispatched.find((d) => d.cmd === 'db.restore')!;
    expect(restore.node).toBe('n-data');
    expect(restore.payload).toMatchObject({ pitrStamp: 's1', pitrAction: 'restore', dataVolume: 'qa-data_pitrcopy-primary-data' });
    // (1) no password rides the wire, and none was read from a running member first
    expect((restore.payload.conn as { password: string }).password).toBe('');
    expect(w.dispatched.findIndex((d) => d.cmd === 'exec')).toBeGreaterThan(w.dispatched.findIndex((d) => d.cmd === 'db.restore'));
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0]!.metadata).toMatchObject({ status: 'succeeded', backupName: 'base_000000010000000000000002', stamp: 's1' });
  });

  it("the roles get the TARGET's password from its mounted secret, in-member (never a value on the wire)", async () => {
    const w = world();
    await runPitrRestore(w.ctx, plan, fast);
    const roles = w.dispatched.find((d) => d.cmd === 'exec' && (d.payload.cmd as string[])[2]!.includes('ALTER ROLE'))!;
    const script = (roles.payload.cmd as string[])[2]!;
    expect(script).toContain('cat /run/secrets/qa-data_pitrcopy-pg-password');
    expect(script).not.toContain('PGPASSWORD=');
  });
});

describe('runPitrRestore: failure paths', () => {
  it('a target that will not stop is never touched, and is started again', async () => {
    const w = world({ neverStops: true });
    await expect(runPitrRestore(w.ctx, plan, { ...fast, stopWaitMs: 0 })).rejects.toThrow(/did not stop, so nothing was restored/);
    expect(w.log).toEqual(['scale 0', 'scale 1']);
    expect(w.audits[0]!.metadata.status).toBe('failed');
  });

  it("a failed restore (agent rolled back) restarts the target on its data and reports the error's TAIL", async () => {
    const noise = 'INFO: fetching part\n'.repeat(80);
    const w = world({ restoreError: `${noise}ERROR: found file PG_VERSION in directory /var/lib/postgresql/data/pgdata` });
    const err = (await runPitrRestore(w.ctx, plan, fast).catch((e: Error) => e)) as Error;
    expect(err.message).toContain('started again on its previous data');
    expect(err.message).toContain('ERROR: found file PG_VERSION in directory');
    expect(w.log).toEqual(['scale 0', 'db.restore restore', 'scale 1']);
  });

  it('a server that never promotes is stopped, rolled back to the kept PGDATA, and started again', async () => {
    const w = world({ recoveryTicks: Infinity });
    let clock = 0;
    const err = (await runPitrRestore(w.ctx, plan, { ...fast, now: () => (clock += 60_000), promoteWaitMs: 5 * 60_000 }).catch(
      (e: Error) => e,
    )) as Error;
    expect(err.message).toMatch(/did not recover: recovery did not finish within 5 min .*previous data was put back/);
    const tail = w.log.slice(w.log.lastIndexOf('scale 0'));
    expect(tail).toEqual(['scale 0', 'db.restore rollback', 'scale 1']);
    expect(w.log).not.toContain('exec cleanup');
    expect(w.audits[0]!.metadata).toMatchObject({ status: 'failed', rolledBack: true });
    const rollback = w.dispatched.filter((d) => d.cmd === 'db.restore')[1]!;
    expect(rollback.payload).toMatchObject({ pitrAction: 'rollback', pitrStamp: 's1' });
  });

  it('a crash-looping server fails early (no 30-minute wait) and is rolled back', async () => {
    const w = world({ recoveryTicks: Infinity, crashLoop: true });
    const err = (await runPitrRestore(w.ctx, plan, fast).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/keeps restarting during recovery/);
    expect(w.log.filter((l) => l === 'exec in-recovery?').length).toBeLessThanOrEqual(3);
    expect(w.log).toContain('db.restore rollback');
  });

  it('never restores while the target is running', async () => {
    for (const opts of [{}, { recoveryTicks: Infinity }] as WorldOpts[]) {
      const w = world(opts);
      await runPitrRestore(w.ctx, plan, { ...fast, promoteWaitMs: 0 }).catch(() => undefined);
      expect(w.log.some((l) => l.includes('WHILE RUNNING'))).toBe(false);
    }
  });
});

describe('pure helpers', () => {
  it('cleanup resets every recovery setting, reloads, and drops the prefetched WAL', () => {
    const s = pitrCleanupScript();
    for (const k of ['restore_command', 'recovery_target_time', 'recovery_target_action', 'recovery_target_timeline']) {
      expect(s).toContain(`ALTER SYSTEM RESET ${k};`);
    }
    expect(s).toContain('SELECT pg_reload_conf();');
    expect(s).toContain('rm -rf "$(dirname "${PGDATA:?}")/pitr-wal"');
  });
  it('stamp and error tail', () => {
    expect(pitrStamp(Date.parse('2026-09-26T10:15:30.123Z'))).toBe('20260926T101530Z');
    const long = `${'x'.repeat(2000)}REAL REASON`;
    const t = errorTail(new Error(long));
    expect(t.endsWith('REAL REASON')).toBe(true);
    expect(t.startsWith('…')).toBe(true);
    expect(errorTail('short')).toBe('short');
  });
});
