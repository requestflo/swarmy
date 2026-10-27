import { describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { encodeScheduleLabel } from './dbBackup.service';
import { nextCopyRecord } from './dbBackupCopy.label';
import { dbCopySignal, dbOnePlaceProblems, type DbCopySignal } from './resilience.db-copies';
import { seedKvRows } from './swarm-kv.service';

/**
 * `db-one-place`: a production database whose backups exist in only one
 * place is a warning, with the fix on its backups page. A second copy that
 * has landed quiets it; one set up but not made yet is said gently; one that
 * never landed says why.
 */

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-db-one-place';

type Cluster = DbCopySignal['clusters'][number];
const cluster = (over: Partial<Cluster> = {}): Cluster => ({
  stack: 'shop', cluster: 'main', production: true, engine: 'pg_dump', targetName: 'swarmy-object-storage',
  inCluster: true, copy: 'none', lastError: null, offsite: false, ...over,
});
const only = (c: Cluster) => dbOnePlaceProblems({ clusters: [c] });

describe('dbOnePlaceProblems', () => {
  it('a production database saved only inside the cluster is a warning that links to its backups', () => {
    expect(only(cluster())).toEqual([{
      id: 'db-one-place/shop/main', check: 'db-one-place', severity: 'warn',
      title: 'Production database shop/main has its backups in one place',
      detail: 'Every save stays inside this cluster (swarmy-object-storage): losing the cluster loses the database and its backups together.',
      fixHint: 'Pick a second destination, ideally off-site, under “Also copy to” on its backups.',
      fixPath: '/stacks/shop/backups', fixLabel: 'Add a second copy', resource: 'shop/main',
    }]);
    expect(only(cluster({ inCluster: false, targetName: 'B2' }))[0]!.detail).toBe("Every save goes to one destination (B2): if it is lost or can't be reached, nothing else can restore shop/main.");
  });

  it('a copy that never landed says why; one not made yet is info; pgBackRest says how to get a copy at all', () => {
    const failing = only(cluster({ copy: 'never-landed', lastError: 'AccessDenied' }))[0]!;
    expect(failing).toMatchObject({ severity: 'warn', fixLabel: 'See why the copy fails' });
    expect(failing.detail).toContain('never landed: AccessDenied');
    expect(only(cluster({ copy: 'pending' }))[0]).toMatchObject({ severity: 'info', fixLabel: 'Back it up now' });
    expect(only(cluster({ engine: 'pgbackrest' }))[0]!.fixHint).toContain('wal-g or pg_dump');
  });

  it('quiet once a second copy has landed, outside production, and without the signal', () => {
    expect(only(cluster({ copy: 'landed' }))).toEqual([]);
    expect(only(cluster({ production: false }))).toEqual([]);
    expect(dbOnePlaceProblems(undefined)).toEqual([]);
  });
});

describe('dbCopySignal', () => {
  const target = (id: string, kind: string, endpoint: string | null) => ({
    id, name: id, kind, endpoint, bucket: 'b', prefix: null, region: null, credentialRef: null, secretKeyRef: null,
    resticPasswordRef: encryptSecret('pw'), enabled: true, createdAt: new Date('2026-10-01T00:00:00Z'),
  });
  const primary = (stack: string, labels: Record<string, string>) => ({
    id: stack, name: `${stack}_main-primary`, image: 'pg', mode: 'replicated' as const, desiredReplicas: 1, runningReplicas: 1, env: [], networks: [], ports: [],
    labels: { 'com.docker.stack.namespace': stack, 'swarmy.db.cluster': 'main', 'swarmy.db.role': 'primary', ...labels },
  });

  it('reads each scheduled cluster: production, where saves go, and whether a copy landed off-site', async () => {
    const landed = nextCopyRecord(null, { targetId: 'r2', savedAt: '2026-10-27T03:00:00Z', startedAt: '2026-10-27T03:01:00Z', status: 'succeeded', snapshotId: 'c1' });
    const services = [
      primary('shop', { 'swarmy.db.backup.schedule': encodeScheduleLabel({ cron: '0 3 * * *', engine: 'pg_dump', retentionDays: 7, pitr: false, targetId: 'garage', secondaryTargetId: 'r2' }), 'swarmy.db.backup.copy': JSON.stringify(landed), 'swarmy.env': 'production' }),
      primary('blog', { 'swarmy.db.backup.schedule': encodeScheduleLabel({ cron: '0 3 * * *', engine: 'pg_dump', retentionDays: 7, pitr: false }) }),
      primary('lab', {}),
    ];
    const hub = { managerNode: () => 'n1', liveInventory: () => ({ services, containers: [] }) };
    seedKvRows(hub as never, 'org1', 'bkp-target', [target('garage', 'S3', 'http://swarmy-garage:3900'), target('r2', 'S3', 'https://acct.r2.cloudflarestorage.com')]);
    const ctx = { hub, activeOrgId: 'org1', db: {} } as unknown as OrgContext;
    const sig = await dbCopySignal(ctx);
    expect(sig.clusters.map((c) => [c.stack, c.production, c.inCluster, c.copy, c.offsite])).toEqual([
      ['shop', true, true, 'landed', true],
      ['blog', false, true, 'none', false],
    ]);
    expect((await dbCopySignal(ctx, 'blog')).clusters.map((c) => c.stack)).toEqual(['blog']);
  });
});
