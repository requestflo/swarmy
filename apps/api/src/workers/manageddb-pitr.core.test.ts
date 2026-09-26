import { describe, expect, it } from 'bun:test';
import {
  MANAGED_PG_PITR_CONF_TARGET,
  PITR_ARCHIVE_COMMAND,
  WAL_ARCHIVE_MOUNT,
  pitrExtraConf,
} from '@swarmy/core/protocol';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shipperScript } from './manageddb-reconcile.core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import {
  DB_BACKUP_AUTO_LABEL,
  DB_BACKUP_LAST_RUN_LABEL,
  DB_BACKUP_PITR_LABEL,
  DB_BACKUP_SCHEDULE_LABEL,
  DB_PITR_APPLIED_LABEL,
  pitrPrimarySpec,
  planBackupIntentCarry,
  preparePitrPrimary,
  rehomeScheduleLabel,
  DB_WAL_SHIPPER_REV_LABEL,
  walShipperNetworks,
  walShipperRev,
  walShipperSpec,
  walShipperUpToDate,
  DB_PITR_ARCHIVE_CMD_LABEL,
  PITR_ARCHIVE_COMMAND_HASH,
  archiveCommandReloadScript,
  archiveCommandStale,
  pitrConfName,
} from './manageddb-pitr.core';

/**
 * QA-068: PITR follows the LIVE primary (the `swarmy.db.role` label), not the
 * boot env. A failover promotes a replica by flipping labels only, so the new
 * writer still has replica env and none of the backup labels.
 */

const base = 'shop_main';
const schedule = JSON.stringify({
  cron: '0 * * * *',
  engine: 'wal-g',
  retentionDays: 14,
  pitr: true,
  targetId: 't1',
  dataVolume: 'shop_main-primary-data',
});

/** `<base>-replica`, promoted by a failover: live role primary, boot env replica. */
function promotedReplica(over: Partial<SwarmServiceInfo> = {}): SwarmServiceInfo {
  return {
    id: 'svc-replica',
    name: `${base}-replica`,
    image: 'pgvector/pgvector:pg17',
    desiredReplicas: 1,
    runningReplicas: 1,
    labels: {
      'swarmy.db.engine': 'postgres',
      'swarmy.db.cluster': 'main',
      'swarmy.db.role': 'primary',
      'swarmy.db.leader': `${base}-replica`,
      'swarmy.db.dataVolume': `${base}-replica-data`,
      'swarmy.db.avoidNode': 'node-a',
    },
    env: [
      'SWARMY_PG_ROLE=replica',
      'POSTGRES_PASSWORD=pw',
      'SWARMY_PG_PRIMARY_HOST=shop_main-primary',
      'SWARMY_PG_PRIMARY_PORT=5432',
      'SWARMY_PG_REJOIN=shop_main-replica@2026-09-01T00:00:00.000Z',
      'SWARMY_PG_REPLICATION_USER=repl',
    ],
    networks: [{ name: `${base}-net` }],
    ...over,
  } as SwarmServiceInfo;
}

const envOf = (s: { env?: Record<string, string> }) => s.env ?? {};

describe('preparePitrPrimary: the live role decides, not the boot env', () => {
  it('a primary deployed as a primary is used unchanged', () => {
    const p = promotedReplica({ env: ['SWARMY_PG_ROLE=primary', 'POSTGRES_PASSWORD=pw'] });
    const prep = preparePitrPrimary(p, 'node-b');
    expect(prep).toEqual({ kind: 'ready', primary: p, promoted: false });
  });

  it('a promoted primary (boot env replica) is prepared as a writer pinned to its node', () => {
    const prep = preparePitrPrimary(promotedReplica(), 'node-b');
    if (prep.kind !== 'ready') throw new Error('expected ready');
    expect(prep.promoted).toBe(true);
    expect(prep.primary.labels['swarmy.db.node']).toBe('node-b');
    expect(prep.primary.labels['swarmy.db.avoidNode']).toBeUndefined();
    expect(prep.primary.env).toContain('SWARMY_PG_ROLE=primary');
    expect(prep.primary.env).toContain('POSTGRES_PASSWORD=pw');
    expect(prep.primary.env?.some((e) => e.startsWith('SWARMY_PG_PRIMARY_HOST='))).toBe(false);
    expect(prep.primary.env?.some((e) => e.startsWith('SWARMY_PG_REJOIN='))).toBe(false);
  });

  it('an existing pin wins over the observed task node', () => {
    const p = promotedReplica({ labels: { ...promotedReplica().labels, 'swarmy.db.node': 'node-c' } });
    const prep = preparePitrPrimary(p, 'node-b');
    expect(prep.kind === 'ready' && prep.primary.labels['swarmy.db.node']).toBe('node-c');
  });

  it('waits (never redeploys) without a node to pin the node-local data to', () => {
    expect(preparePitrPrimary(promotedReplica(), undefined).kind).toBe('wait');
  });

  it('never rewrites a multi-task service into one writer spec', () => {
    expect(preparePitrPrimary(promotedReplica({ desiredReplicas: 2 }), 'node-b').kind).toBe('wait');
  });
});

describe('pitrPrimarySpec on a failover-promoted primary (QA-068)', () => {
  it('applies archive volume, PITR conf, marker, writer env and the pin', () => {
    const prep = preparePitrPrimary(promotedReplica(), 'node-b');
    if (prep.kind !== 'ready') throw new Error('expected ready');
    const spec = pitrPrimarySpec(prep.primary, { base }, `${base}-net`, 'v1', `${base}-replica-data`);
    expect(spec.name).toBe(`${base}-replica`);
    expect(spec.labels?.[DB_PITR_APPLIED_LABEL]).toBe('v1');
    expect(spec.labels?.['swarmy.db.role']).toBe('primary');
    expect(envOf(spec)['SWARMY_PG_ROLE']).toBe('primary');
    expect(envOf(spec)['SWARMY_PG_PRIMARY_HOST']).toBeUndefined();
    expect(spec.mounts).toContainEqual({ type: 'volume', source: `${base}-wal-archive`, target: WAL_ARCHIVE_MOUNT });
    expect(spec.mounts?.some((m) => m.source === `${base}-replica-data`)).toBe(true);
    expect(spec.configs).toContainEqual({ source: pitrConfName(base), target: MANAGED_PG_PITR_CONF_TARGET });
    expect(spec.placement?.constraints).toContain('node.id==node-b');
    expect(spec.placement?.constraints?.some((c) => c.startsWith('node.id!='))).toBe(false);
  });

  it('is idempotent: once applied, the next tick prepares an unchanged primary', () => {
    const prep = preparePitrPrimary(promotedReplica(), 'node-b');
    if (prep.kind !== 'ready') throw new Error('expected ready');
    const spec = pitrPrimarySpec(prep.primary, { base }, `${base}-net`, 'v1', undefined);
    const live = promotedReplica({
      labels: spec.labels ?? {},
      env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
    });
    const next = preparePitrPrimary(live, 'node-b');
    expect(next.kind === 'ready' && next.promoted).toBe(false);
    expect(next.kind === 'ready' && next.primary.labels[DB_PITR_APPLIED_LABEL]).toBe('v1');
  });
});

describe('planBackupIntentCarry: backup intent follows the live primary', () => {
  const exPrimary = {
    name: `${base}-primary`,
    labels: {
      'swarmy.db.role': 'replica',
      [DB_BACKUP_SCHEDULE_LABEL]: schedule,
      [DB_BACKUP_PITR_LABEL]: 'true',
      [DB_BACKUP_LAST_RUN_LABEL]: '{"at":"2026-09-01T00:00:00Z","status":"succeeded","engine":"wal-g"}',
    },
  };

  it('moves schedule + pitr + lastRun from the demoted ex-primary to the new writer', () => {
    const carry = planBackupIntentCarry(promotedReplica(), [exPrimary]);
    expect(carry).not.toBeNull();
    expect(carry!.add[DB_BACKUP_PITR_LABEL]).toBe('true');
    expect(carry!.add[DB_BACKUP_LAST_RUN_LABEL]).toBe(exPrimary.labels[DB_BACKUP_LAST_RUN_LABEL]);
    const moved = JSON.parse(carry!.add[DB_BACKUP_SCHEDULE_LABEL]!);
    expect(moved).toEqual({ cron: '0 * * * *', engine: 'wal-g', retentionDays: 14, pitr: true, targetId: 't1' });
    expect(carry!.donors).toEqual([
      { name: `${base}-primary`, removeKeys: [DB_BACKUP_SCHEDULE_LABEL, DB_BACKUP_PITR_LABEL, DB_BACKUP_LAST_RUN_LABEL] },
    ]);
  });

  it('steady state: nothing to carry', () => {
    expect(planBackupIntentCarry(promotedReplica(), [{ name: `${base}-primary`, labels: {} }])).toBeNull();
  });

  it("the primary's own user schedule wins; the donor's stale copy is still cleared", () => {
    const own = JSON.stringify({ cron: '5 * * * *', engine: 'pg_dump', retentionDays: 7, pitr: false });
    const p = promotedReplica({ labels: { ...promotedReplica().labels, [DB_BACKUP_SCHEDULE_LABEL]: own } });
    const carry = planBackupIntentCarry(p, [exPrimary])!;
    expect(carry.add[DB_BACKUP_SCHEDULE_LABEL]).toBeUndefined();
    expect(carry.donors[0]!.removeKeys).toContain(DB_BACKUP_SCHEDULE_LABEL);
  });

  it("a user schedule replaces an auto default stamped on the new writer", () => {
    const auto = JSON.stringify({ cron: '0 3 * * *', engine: 'pg_dump', retentionDays: 7, pitr: false, auto: true });
    const p = promotedReplica({ labels: { ...promotedReplica().labels, [DB_BACKUP_SCHEDULE_LABEL]: auto } });
    const carry = planBackupIntentCarry(p, [exPrimary])!;
    expect(JSON.parse(carry.add[DB_BACKUP_SCHEDULE_LABEL]!).engine).toBe('wal-g');
    expect(carry.add[DB_BACKUP_PITR_LABEL]).toBe('true');
  });

  it('a user opt-out on the ex-primary removes an auto default from the new writer', () => {
    const auto = JSON.stringify({ cron: '0 3 * * *', engine: 'pg_dump', retentionDays: 7, pitr: false, auto: true });
    const p = promotedReplica({ labels: { ...promotedReplica().labels, [DB_BACKUP_SCHEDULE_LABEL]: auto } });
    const carry = planBackupIntentCarry(p, [{ name: `${base}-primary`, labels: { [DB_BACKUP_AUTO_LABEL]: 'off' } }])!;
    expect(carry.add[DB_BACKUP_AUTO_LABEL]).toBe('off');
    expect(carry.removeFromPrimary).toContain(DB_BACKUP_SCHEDULE_LABEL);
  });

  it('rehomeScheduleLabel drops only the old node-local dataVolume', () => {
    expect(JSON.parse(rehomeScheduleLabel(schedule)).dataVolume).toBeUndefined();
    const noVol = JSON.stringify({ cron: '0 * * * *', engine: 'pg_dump' });
    expect(rehomeScheduleLabel(noVol)).toBe(noVol);
    expect(rehomeScheduleLabel('not json')).toBe('not json');
  });
});

describe('wal-shipper: storage network + revision (QA-080)', () => {
  const c = { base, stack: 'shop', cluster: 'main' };
  const writer = { labels: { 'swarmy.db.node': 'node-b' } };

  it('joins the storage overlay for an in-cluster destination, only the cluster net otherwise', () => {
    expect(walShipperNetworks(`${base}-net`, 'swarmy')).toEqual([`${base}-net`, 'swarmy']);
    expect(walShipperNetworks(`${base}-net`, undefined)).toEqual([`${base}-net`]);
  });

  it('the spec carries both networks, the archive mount, the pin and the revision', () => {
    const nets = walShipperNetworks(`${base}-net`, 'swarmy');
    const spec = walShipperSpec(c, 'v1', `${base}-wal-creds-v1`, writer, nets);
    expect(spec.networks).toEqual([`${base}-net`, 'swarmy']);
    expect(spec.mounts).toContainEqual({ type: 'volume', source: `${base}-wal-archive`, target: WAL_ARCHIVE_MOUNT });
    expect(spec.placement?.constraints).toContain('node.id==node-b');
    expect(spec.labels?.[DB_PITR_APPLIED_LABEL]).toBe('v1');
    expect(spec.labels?.[DB_WAL_SHIPPER_REV_LABEL]).toBe(walShipperRev(nets));
    expect(spec.command?.join(' ')).toContain('mkdir -p /wal-archive/archive_status');
  });

  it('a shipper from before the fix (same PITR version, no revision) is redeployed once, then left alone', () => {
    const nets = walShipperNetworks(`${base}-net`, 'swarmy');
    const old = { labels: { [DB_PITR_APPLIED_LABEL]: 'v1' } };
    expect(walShipperUpToDate(old, 'v1', nets)).toBe(false);
    const deployed = walShipperSpec(c, 'v1', 's', writer, nets);
    expect(walShipperUpToDate({ labels: deployed.labels ?? {} }, 'v1', nets)).toBe(true);
    // A changed destination network is a new revision.
    expect(walShipperUpToDate({ labels: deployed.labels ?? {} }, 'v1', [`${base}-net`])).toBe(false);
    expect(walShipperUpToDate(undefined, 'v1', nets)).toBe(false);
  });
});

/**
 * Atomic WAL archive: Postgres copies each segment to a hidden temp name and
 * renames it into place, and the shipper never sees a half-copied segment.
 * Rolled out to running primaries by a reload, not a restart.
 */
describe('atomic WAL archive', () => {
  const sh = (script: string, env: Record<string, string> = {}) =>
    Bun.spawnSync(['sh', '-c', script], { env: { PATH: '/usr/bin:/bin', ...env }, stdout: 'pipe', stderr: 'pipe' });

  /** archive_command as Postgres runs it: %p/%f substituted, the archive dir relocated. */
  const archive = (dir: string, src: string, seg: string) =>
    sh(PITR_ARCHIVE_COMMAND.replaceAll(WAL_ARCHIVE_MOUNT, dir).replaceAll('%p', src).replaceAll('%f', seg));

  it('archive_command copies to .<seg>.tmp then renames, and never overwrites', () => {
    expect(PITR_ARCHIVE_COMMAND).toBe(
      'test ! -f /wal-archive/%f && cp %p /wal-archive/.%f.tmp && mv /wal-archive/.%f.tmp /wal-archive/%f',
    );
    const dir = mkdtempSync(join(tmpdir(), 'walarc-'));
    const src = join(dir, 'src');
    writeFileSync(src, 'segment-bytes');
    const arc = join(dir, 'arc');
    sh(`mkdir -p ${arc}`);
    expect(archive(arc, src, '000000010000000000000001').exitCode).toBe(0);
    expect(readdirSync(arc)).toEqual(['000000010000000000000001']);
    expect(readFileSync(join(arc, '000000010000000000000001'), 'utf8')).toBe('segment-bytes');
    // Already archived: Postgres gets a failure and retries, and the file is never clobbered.
    expect(archive(arc, src, '000000010000000000000001').exitCode).not.toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('the shipper pushes only complete segments and leaves an in-flight .tmp alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walship-'));
    const arc = join(dir, 'arc');
    const bin = join(dir, 'bin');
    sh(`mkdir -p ${arc} ${bin}`);
    writeFileSync(join(arc, '000000010000000000000001'), 'done');
    writeFileSync(join(arc, '.000000010000000000000002.tmp'), 'half');
    const pushed = join(dir, 'pushed');
    writeFileSync(join(bin, 'wal-g'), `#!/bin/sh\necho "$2" >> ${pushed}\n`);
    chmodSync(join(bin, 'wal-g'), 0o755);
    const creds = join(dir, 'creds');
    writeFileSync(creds, 'WALG_S3_PREFIX=s3://b\n');
    // One pass of the real loop: relocated paths, and exit instead of sleeping.
    const once = shipperScript()
      .replaceAll('/run/secrets/wal-creds', creds)
      .replaceAll(WAL_ARCHIVE_MOUNT, arc)
      .replace('sleep 10', 'exit 0');
    const r = sh(once, { PATH: `${bin}:/usr/bin:/bin` });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(pushed, 'utf8').trim()).toBe(join(arc, '000000010000000000000001'));
    expect(readdirSync(arc).sort()).toEqual(['.000000010000000000000002.tmp', 'archive_status']);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('the PITR conf config is content-named, so a changed conf is a new config', () => {
    expect(pitrConfName(base)).toMatch(new RegExp(`^${base}-pitr-conf-[0-9a-f]{10}$`));
    expect(pitrExtraConf()).toContain(PITR_ARCHIVE_COMMAND);
  });

  it('a (re)deploy mounts only the current conf generation and stamps the command hash', () => {
    const live = promotedReplica({
      env: ['SWARMY_PG_ROLE=primary'],
      configs: [`${base}-pitr-conf`, `${base}-pitr-conf-0123456789`, 'other-config'],
    } as Partial<SwarmServiceInfo>);
    const spec = pitrPrimarySpec(live, { base }, `${base}-net`, 'v1', undefined);
    expect(spec.configs).toEqual([
      { source: 'other-config' },
      { source: pitrConfName(base), target: MANAGED_PG_PITR_CONF_TARGET },
    ]);
    expect(spec.labels?.[DB_PITR_ARCHIVE_CMD_LABEL]).toBe(PITR_ARCHIVE_COMMAND_HASH);
  });

  it('archiveCommandStale: an old primary reloads once; current conf or stamp = nothing to do', () => {
    expect(archiveCommandStale({ labels: {}, configs: [`${base}-pitr-conf`] }, base)).toBe(true);
    expect(archiveCommandStale({ labels: {}, configs: [pitrConfName(base)] }, base)).toBe(false);
    expect(
      archiveCommandStale({ labels: { [DB_PITR_ARCHIVE_CMD_LABEL]: PITR_ARCHIVE_COMMAND_HASH }, configs: [`${base}-pitr-conf`] }, base),
    ).toBe(false);
  });

  it('the reload is ALTER SYSTEM + pg_reload_conf (no restart), the command passed as a psql variable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reload-'));
    const log = join(dir, 'log');
    writeFileSync(
      join(dir, 'psql'),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${log}.args\ncat > ${log}.sql\n`,
    );
    chmodSync(join(dir, 'psql'), 0o755);
    const r = sh(archiveCommandReloadScript('PGPASSWORD=x'), { PATH: `${dir}:/usr/bin:/bin` });
    expect(r.exitCode).toBe(0);
    const args = readFileSync(`${log}.args`, 'utf8').split('\n');
    expect(args).toContain(`cmd=${PITR_ARCHIVE_COMMAND}`);
    expect(args).toContain('ON_ERROR_STOP=1');
    const sql = readFileSync(`${log}.sql`, 'utf8');
    expect(sql).toContain("ALTER SYSTEM SET archive_command = :'cmd';");
    expect(sql).toContain('SELECT pg_reload_conf();');
    expect(sql).not.toMatch(/restart|pg_ctl/);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
