import { describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { DbWalVerifyResult } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { restoreDb } from './dbBackup.service';
import { getDbWalCheck } from './dbWalCheck.service';
import { seedKvRows } from './swarm-kv.service';

/**
 * `dbBackups.walCheck` sends `db.walVerify` only to an agent that advertised
 * it, reads the primary's password only then, and reuses a fresh read. A gap
 * the check found is refused by the PITR preflight before anything is saved
 * or stopped. Against an in-memory hub.
 */

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-db-wal-check';

const VERIFY: DbWalVerifyResult = {
  integrity: 'failure',
  ranges: [
    { timeline: 1, startSegment: 'S02', endSegment: 'S09', segments: 8, status: 'found', from: '2026-10-20T03:00:00.000Z', to: '2026-10-21T13:10:00.000Z' },
    { timeline: 1, startSegment: 'S0A', endSegment: 'S0B', segments: 2, status: 'lost', from: '2026-10-21T13:10:00.000Z', to: '2026-10-21T13:25:00.000Z' },
    { timeline: 1, startSegment: 'S0C', endSegment: 'S40', segments: 53, status: 'found', from: '2026-10-21T13:25:00.000Z', to: '2026-10-24T09:15:00.000Z' },
  ],
  backups: [{ name: 'base_000000010000000000000002', finishTime: '2026-10-20T03:00:00.000Z' }],
  checkedAt: '2026-10-24T09:20:00.000Z',
};
const WINDOW = {
  backups: VERIFY.backups,
  window: { from: '2026-10-20T03:00:00.000Z', to: '2026-10-24T09:15:00.000Z' },
  latestWalAt: '2026-10-24T09:15:00.000Z',
  checkedAt: '2026-10-24T09:20:00.000Z',
};
const SCHEDULE = JSON.stringify({ cron: '0 3 * * *', engine: 'wal-g', retentionDays: 7, pitr: true, targetId: 'tgt-1' });

let org = 0;
function world(capabilities?: string[]) {
  const orgId = `org-wal-${++org}`;
  const calls: Array<{ cmd: string; payload: Record<string, unknown> }> = [];
  const primary = {
    id: 'svc-main', name: 'shop_main-primary', image: 'pgvector/pgvector:pg17', mode: 'replicated' as const,
    desiredReplicas: 1, runningReplicas: 1,
    labels: {
      'com.docker.stack.namespace': 'shop', 'swarmy.db.cluster': 'main', 'swarmy.db.role': 'primary',
      'swarmy.db.dataVolume': 'shop_main-primary-data', 'swarmy.db.backup.schedule': SCHEDULE,
    },
    env: ['POSTGRES_PASSWORD=pw-from-env', 'POSTGRES_DB=app'], networks: [], ports: [],
  };
  const hub = {
    managerNode: () => 'n1', isOnline: () => true, onlineNodeIds: () => ['n1'], latestContainers: () => [],
    swarmNodeIdFor: () => undefined,
    agentBuildFor: () => ({ version: '1.6.0', ...(capabilities ? { capabilities } : {}) }),
    liveInventory: () => ({ services: [primary], containers: [] }),
    dispatch: async (_n: string, cmd: string, payload: Record<string, unknown>) => {
      calls.push({ cmd, payload });
      if (cmd === 'db.walVerify') return VERIFY;
      if (cmd === 'db.pitrWindow') return WINDOW;
      if (cmd === 'service.scale') throw new Error('stop here');
      return {};
    },
  };
  seedKvRows(hub as never, orgId, 'bkp-target', [
    { id: 'tgt-1', name: 'offsite', kind: 'S3', endpoint: 'https://s3.example.com', bucket: 'b', prefix: 'p', region: null, credentialRef: null, secretKeyRef: null, resticPasswordRef: encryptSecret('pw'), enabled: true },
  ]);
  const ctx = { db: { auditLog: { create: async () => ({}) } }, hub, user: { id: 'u1' }, activeOrgId: orgId, session: null, reqHeaders: new Headers() } as unknown as OrgContext;
  return { ctx, calls, cmds: () => calls.map((c) => c.cmd) };
}

describe('getDbWalCheck', () => {
  it('an agent that predates the command is not sent it: unsupported, and no password is read', async () => {
    const w = world(['dbPitrWindow']);
    const v = await getDbWalCheck(w.ctx, { stack: 'shop', cluster: 'main' });
    expect(v.source).toBe('unsupported');
    expect(w.cmds()).toEqual([]);
  });

  it('verifies on the restore\'s node with the primary\'s connection, the destination and networks', async () => {
    const w = world(['dbPitrWindow', 'dbWalVerify']);
    const v = await getDbWalCheck(w.ctx, { stack: 'shop', cluster: 'main' });
    expect(w.cmds()).toEqual(['db.walVerify']);
    const p = w.calls[0]!.payload as { conn: { host: string; password: string }; repo: { repo: string }; network: string };
    expect(p.conn).toMatchObject({ host: 'shop_main-primary', password: 'pw-from-env' });
    expect(p.repo.repo).toBe('s3:https://s3.example.com/b/p');
    expect(p.network).toBe('shop_main-net');
    expect(v).toMatchObject({ source: 'agent', status: 'gaps', continuousSince: '2026-10-21T13:25:00.000Z' });
    expect(v.gaps[0]).toMatchObject({ from: '2026-10-21T13:10:00.000Z', to: '2026-10-21T13:25:00.000Z', reachableAgainAt: null });
  });

  it('a read from the last few minutes is served again without another sidecar', async () => {
    const w = world(['dbWalVerify']);
    await getDbWalCheck(w.ctx, { stack: 'shop', cluster: 'main' });
    await getDbWalCheck(w.ctx, { stack: 'shop', cluster: 'main' });
    expect(w.cmds()).toEqual(['db.walVerify']);
  });
});

describe('the PITR preflight refuses a target inside a known WAL gap', () => {
  it('before the safety copy and the stop', async () => {
    const w = world(['dbPitrWindow', 'dbWalVerify']);
    await getDbWalCheck(w.ctx, { stack: 'shop', cluster: 'main' });
    await expect(
      restoreDb(w.ctx, { stack: 'shop', cluster: 'main', engine: 'wal-g', mode: 'pitr', targetTime: '2026-10-22T08:00:00Z' }),
    ).rejects.toThrow(/2026-10-22 08:00:00 UTC is out of reach\. The WAL archive of shop\/main has a gap from 2026-10-21 13:10:00 UTC/);
    expect(w.cmds()).toEqual(['db.walVerify', 'db.pitrWindow']);
  });

  it('a time before the gap goes on to the safety copy', async () => {
    const w = world(['dbPitrWindow', 'dbWalVerify']);
    await getDbWalCheck(w.ctx, { stack: 'shop', cluster: 'main' });
    await restoreDb(w.ctx, { stack: 'shop', cluster: 'main', engine: 'wal-g', mode: 'pitr', targetTime: '2026-10-21T12:00:00Z' }).catch(() => undefined);
    expect(w.cmds().slice(0, 3)).toEqual(['db.walVerify', 'db.pitrWindow', 'db.backup']);
  });
});
