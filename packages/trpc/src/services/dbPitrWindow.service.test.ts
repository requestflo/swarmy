import { afterEach, describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { DbPitrWindowResult } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { dbBackupOverview, getDbPitrWindow, restoreDb } from './dbBackup.service';
import { pitrPreflight, pitrWindowView } from './dbPitrWindow.service';
import { seedKvRows } from './swarm-kv.service';

/**
 * A PITR restore reads the real window from the agent BEFORE the safety copy
 * and the stop, and refuses a target outside it. An agent without the
 * command is not sent it: the restore goes ahead as before, and the skip is
 * logged. Against an in-memory hub.
 */

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-db-pitr-window';

const READ: DbPitrWindowResult = {
  backups: [{ name: 'base_000000010000000000000002', finishTime: '2026-10-20T03:00:00.000Z' }],
  window: { from: '2026-10-20T03:00:00.000Z', to: '2026-10-24T09:15:00.000Z' },
  latestWalAt: '2026-10-24T09:15:00.000Z',
  checkedAt: '2026-10-24T09:20:00.000Z',
};
const SCHEDULE = JSON.stringify({ cron: '0 3 * * *', engine: 'wal-g', retentionDays: 7, pitr: true, targetId: 'tgt-1' });

let org = 0;
function world(opts: { capabilities?: string[]; read?: DbPitrWindowResult; readFails?: string } = {}) {
  const orgId = `org-pw-${++org}`; // the last-read cache is per org: keep worlds apart
  const calls: Array<{ cmd: string; payload: Record<string, unknown> }> = [];
  const primary = {
    id: 'svc-main', name: 'shop_main-primary', image: 'pgvector/pgvector:pg17', mode: 'replicated' as const,
    desiredReplicas: 1, runningReplicas: 1,
    labels: {
      'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'main', 'swarmy.db.role': 'primary',
      'swarmy.db.dataVolume': 'shop_main-primary-data', 'swarmy.db.backup.schedule': SCHEDULE,
    },
    env: ['POSTGRES_PASSWORD=pw', 'POSTGRES_DB=app'], networks: [], ports: [],
  };
  const hub = {
    managerNode: () => 'n1', isOnline: () => true, onlineNodeIds: () => ['n1'], latestContainers: () => [],
    swarmNodeIdFor: () => undefined,
    agentBuildFor: () => ({ version: '1.5.0', ...(opts.capabilities ? { capabilities: opts.capabilities } : {}) }),
    liveInventory: () => ({ services: [primary], containers: [] }),
    dispatch: async (_n: string, cmd: string, payload: Record<string, unknown>) => {
      calls.push({ cmd, payload });
      if (cmd === 'db.pitrWindow') {
        if (opts.readFails) throw new Error(opts.readFails);
        return opts.read ?? READ;
      }
      if (cmd === 'db.backup') return { snapshotId: 'safe1', engine: payload.engine, sizeBytes: 10, databases: ['app'] };
      if (cmd === 'service.scale') throw new Error('stop here');
      return {};
    },
  };
  const db = { auditLog: { create: async () => ({}) } };
  seedKvRows(hub as never, orgId, 'bkp-target', [
    { id: 'tgt-1', name: 'offsite', kind: 'S3', endpoint: 'https://s3.example.com', bucket: 'b', prefix: 'p', region: null, credentialRef: null, secretKeyRef: null, resticPasswordRef: encryptSecret('pw'), enabled: true },
  ]);
  const ctx = { db, hub, user: { id: 'u1' }, activeOrgId: orgId, session: null, reqHeaders: new Headers() } as unknown as OrgContext;
  return { ctx, calls, cmds: () => calls.map((c) => c.cmd) };
}

const pitr = (targetTime?: string) => ({ stack: 'shop', cluster: 'main', engine: 'wal-g' as const, mode: 'pitr' as const, targetTime });
const CAPABLE = ['dbPitrWindow'];
const realWarn = console.warn;
afterEach(() => {
  console.warn = realWarn;
});

describe('restoreDb checks the PITR window before anything changes', () => {
  it('a target before the oldest base backup is refused: no safety copy, no stop', async () => {
    const w = world({ capabilities: CAPABLE });
    await expect(restoreDb(w.ctx, pitr('2026-10-19T00:00:00Z'))).rejects.toThrow(
      /Nothing was restored, saved or stopped: 2026-10-19 00:00:00 UTC is before the oldest base backup of shop\/main finished\. shop\/main can be restored to any time from 2026-10-20 03:00:00 UTC/,
    );
    expect(w.cmds()).toEqual(['db.pitrWindow']);
  });

  it('reads the restore\'s own repo and networks', async () => {
    const w = world({ capabilities: CAPABLE });
    await expect(restoreDb(w.ctx, pitr('2026-10-30T00:00:00Z'))).rejects.toThrow(/is after its newest archived change/);
    expect(w.calls[0]!.payload).toMatchObject({ engine: 'wal-g', network: 'shop_main-net', repo: { repo: 's3:https://s3.example.com/b/p' } });
  });

  it('a target inside the window goes on: the safety copy, then the stop', async () => {
    const w = world({ capabilities: CAPABLE });
    await expect(restoreDb(w.ctx, pitr('2026-10-22T12:00:00Z'))).rejects.toThrow(/stop here/);
    expect(w.cmds().slice(0, 3)).toEqual(['db.pitrWindow', 'db.backup', 'service.scale']);
  });

  it('no base backups yet: refused before anything changes, even without a target', async () => {
    const w = world({ capabilities: CAPABLE, read: { backups: [], window: null, checkedAt: READ.checkedAt } });
    await expect(restoreDb(w.ctx, pitr())).rejects.toThrow(/has no base backups yet/);
    expect(w.cmds()).toEqual(['db.pitrWindow']);
  });

  it('a failed read refuses too, before the save and the stop', async () => {
    const w = world({ capabilities: CAPABLE, readFails: 'ERROR: Access Denied' });
    await expect(restoreDb(w.ctx, pitr('2026-10-22T12:00:00Z'))).rejects.toThrow(
      /couldn't read the recoverable window of shop\/main from its WAL repo, so nothing was restored, saved or stopped: ERROR: Access Denied/,
    );
    expect(w.cmds()).toEqual(['db.pitrWindow']);
  });

  it('an older agent is never sent the command: today\'s behaviour, and the skip is logged', async () => {
    const warned: string[] = [];
    console.warn = (m: string) => void warned.push(m);
    const w = world(); // no capabilities in its register facts
    await expect(restoreDb(w.ctx, pitr('2026-10-19T00:00:00Z'))).rejects.toThrow(/stop here/);
    expect(w.cmds().slice(0, 2)).toEqual(['db.backup', 'service.scale']);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('[dbBackup] PITR preflight skipped for shop/main: the agent 1.5.0 on node n1 cannot read the window');
  });

  it('pgbackrest has no window check yet: skipped and logged', async () => {
    const warned: string[] = [];
    const w = world({ capabilities: CAPABLE });
    const r = await pitrPreflight(w.ctx, { ref: 'shop/main', engine: 'pgbackrest', nodeId: 'n1', repo: { kind: 's3', repo: 's3:x/b', password: 'p' } }, (m) => void warned.push(m));
    expect(r).toBeNull();
    expect(w.cmds()).toEqual([]);
    expect(warned[0]).toContain('only a wal-g window can be read');
  });
});

describe('the dashboard window prefers the agent\'s read', () => {
  it('the overview estimates until the agent has read the window, then shows the real one', async () => {
    const w = world({ capabilities: CAPABLE });
    const before = (await dbBackupOverview(w.ctx))[0]!;
    expect(before.pitrWindowSource).toBe('estimate');
    const view = await getDbPitrWindow(w.ctx, { stack: 'shop', cluster: 'main' });
    expect(view).toMatchObject({ source: 'agent', window: READ.window, latestWalAt: READ.latestWalAt });
    const after = (await dbBackupOverview(w.ctx))[0]!;
    expect(after.pitrWindow).toEqual(READ.window);
    expect(after.pitrWindowSource).toBe('agent');
  });

  it('an older agent answers unsupported, and nothing is dispatched', async () => {
    const w = world();
    expect((await getDbPitrWindow(w.ctx, { stack: 'shop', cluster: 'main' })).source).toBe('unsupported');
    expect(w.cmds()).toEqual([]);
  });

  it('carries each base backup’s data size, stringified, when wal-g reported it', () => {
    const backups = [{ ...READ.backups[0]!, sizeBytes: 268_435_456 }, { name: 'base_000000010000000000000009', finishTime: '2026-10-22T03:00:00.000Z' }];
    expect(pitrWindowView({ status: 'read', result: { ...READ, backups } }).backups).toEqual([
      { name: 'base_000000010000000000000002', finishTime: '2026-10-20T03:00:00.000Z', sizeBytes: '268435456' },
      { name: 'base_000000010000000000000009', finishTime: '2026-10-22T03:00:00.000Z' },
    ]);
  });
});
