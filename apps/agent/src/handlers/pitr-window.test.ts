import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import type { DbPitrWindowPayload } from '@swarmy/core/protocol';
import {
  WAL_LISTING_MARKER,
  dbPitrWindow,
  latestWalUpload,
  parseWalgBackups,
  parseWindowOutput,
  pitrWindowOf,
  walgWindowScript,
} from './pitr-window';

/**
 * The PITR window check reads the WAL repo and nothing else: the base
 * backups (oldest first), the window from the oldest backup's finish to the
 * newest archived change, and a clear "none yet" when there are no backups.
 */

const LIST = JSON.stringify([
  { backup_name: 'base_000000010000000000000009', start_time: '2026-10-22T02:58:00Z', finish_time: '2026-10-22T03:00:00Z' },
  { backup_name: 'base_000000010000000000000002', finish_time: '2026-10-20T03:00:00Z' },
  { backup_name: 'base_broken' },
]);
const WAL = [
  'type size last modified                    name',
  'obj  1024 2026-10-24 09:10:00.123456 +0000 UTC wal_005/00000001000000000000000A.lz4',
  'obj  1024 2026-10-24 09:15:00 +0000 UTC     wal_005/00000001000000000000000B.lz4',
  'obj  80   2026-10-25 00:00:00 +0000 UTC     wal_005/00000002.history.lz4',
  'dir  0    0001-01-01 00:00:00 +0000 UTC     wal_005/archive_status/',
].join('\n');

describe('parseWalgBackups', () => {
  it('lists the base backups oldest first, skipping rows with no name or finish', () => {
    expect(parseWalgBackups(LIST)).toEqual([
      { name: 'base_000000010000000000000002', finishTime: '2026-10-20T03:00:00.000Z' },
      { name: 'base_000000010000000000000009', startTime: '2026-10-22T02:58:00.000Z', finishTime: '2026-10-22T03:00:00.000Z' },
    ]);
  });
  it('empty output is no backups yet; anything unreadable is an error', () => {
    expect(parseWalgBackups('  \n')).toEqual([]);
    expect(() => parseWalgBackups('INFO: no json here')).toThrow(/could not read the wal-g backup list/);
  });
});

describe('latestWalUpload', () => {
  it('the newest WAL segment upload; history files and directories do not count', () => {
    expect(latestWalUpload(WAL)).toBe('2026-10-24T09:15:00.000Z');
  });
  it('an unreadable or empty listing gives no time', () => {
    expect(latestWalUpload('')).toBeUndefined();
    expect(latestWalUpload('ERROR: unknown command "st"')).toBeUndefined();
  });
  it('reads an ISO time and an offset zone too', () => {
    expect(latestWalUpload('2026-10-24T11:00:00+02:00 00000001000000000000000C')).toBe('2026-10-24T09:00:00.000Z');
  });
});

describe('pitrWindowOf', () => {
  const backups = parseWalgBackups(LIST);
  it('runs from the oldest base backup finish to the newest archived change', () => {
    expect(pitrWindowOf(backups, '2026-10-24T09:15:00.000Z', '2026-10-24T09:20:00.000Z')).toEqual({
      from: '2026-10-20T03:00:00.000Z',
      to: '2026-10-24T09:15:00.000Z',
    });
  });
  it('without a WAL listing it ends at the check time, and never before the newest backup', () => {
    expect(pitrWindowOf(backups, undefined, '2026-10-24T09:20:00.000Z')?.to).toBe('2026-10-24T09:20:00.000Z');
    expect(pitrWindowOf(backups, '2026-10-21T00:00:00.000Z', '2026-10-24T09:20:00.000Z')?.to).toBe('2026-10-22T03:00:00.000Z');
  });
  it('no base backups: no window', () => {
    expect(pitrWindowOf([], '2026-10-24T09:15:00.000Z', '2026-10-24T09:20:00.000Z')).toBeNull();
  });
});

describe('parseWindowOutput', () => {
  it('splits the backup list from the WAL listing', () => {
    const r = parseWindowOutput(`${LIST}\n${WAL_LISTING_MARKER}\n${WAL}`, '2026-10-24T09:20:00.000Z');
    expect(r.backups).toHaveLength(2);
    expect(r.latestWalAt).toBe('2026-10-24T09:15:00.000Z');
    expect(r.window).toEqual({ from: '2026-10-20T03:00:00.000Z', to: '2026-10-24T09:15:00.000Z' });
    expect(r.checkedAt).toBe('2026-10-24T09:20:00.000Z');
  });
  it('no WAL section: the window ends at the check time and latestWalAt is absent', () => {
    const r = parseWindowOutput(LIST, '2026-10-24T09:20:00.000Z');
    expect(r.latestWalAt).toBeUndefined();
    expect(r.window?.to).toBe('2026-10-24T09:20:00.000Z');
  });
});

function fakeDocker(out: { stdout?: string; stderr?: string; exit?: number }) {
  const created: Array<{ Cmd: string[]; Env: string[]; HostConfig: { Binds: string[]; NetworkMode?: string } }> = [];
  const joined: string[] = [];
  const docker = {
    pullImage: async () => undefined,
    docker: {
      getNetwork: (n: string) => ({ connect: async () => void joined.push(n) }),
      modem: {
        demuxStream: (_s: unknown, o: { write(b: Buffer): void }, e: { write(b: Buffer): void }) => {
          if (out.stdout) o.write(Buffer.from(out.stdout));
          if (out.stderr) e.write(Buffer.from(out.stderr));
        },
      },
      createContainer: async (o: (typeof created)[number]) => {
        created.push(o);
        return { id: 'c1', attach: async () => ({}), start: async () => undefined, wait: async () => ({ StatusCode: out.exit ?? 0 }), kill: async () => undefined, remove: async () => undefined };
      },
    },
  } as unknown as DockerClient;
  return { docker, created, joined };
}

const payload: DbPitrWindowPayload = {
  commandId: 'c1',
  engine: 'wal-g',
  repo: { kind: 's3', repo: 's3:http://swarmy-garage:3900/bkt/pfx', password: 'rp', accessKeyId: 'AK', secretAccessKey: 'SK' },
  network: 'shop_main-net',
  resticNetwork: 'swarmy',
};

describe('dbPitrWindow', () => {
  it('runs wal-g backup-list read-only: no volume, credentials as env, the restore networks', async () => {
    const { docker, created, joined } = fakeDocker({ stdout: `${LIST}\n${WAL_LISTING_MARKER}\n${WAL}` });
    const r = await dbPitrWindow(docker, payload, () => Date.parse('2026-10-24T09:20:00Z'));
    expect(created).toHaveLength(1);
    expect(created[0]!.HostConfig.Binds).toEqual([]);
    expect(created[0]!.Cmd).toEqual([walgWindowScript()]);
    expect(created[0]!.Cmd[0]).toContain('wal-g backup-list --json --detail');
    expect(created[0]!.Env).toContain('WALG_S3_PREFIX=s3://bkt/pfx');
    expect(created[0]!.Env).toContain('AWS_SECRET_ACCESS_KEY=SK');
    expect(created[0]!.HostConfig.NetworkMode).toBe('shop_main-net');
    expect(joined).toEqual(['swarmy']);
    expect(r.window).toEqual({ from: '2026-10-20T03:00:00.000Z', to: '2026-10-24T09:15:00.000Z' });
  });
  it('a failed list reports the tail of stderr', async () => {
    const { docker } = fakeDocker({ stderr: 'INFO: start\nERROR: Access Denied\n', exit: 1 });
    await expect(dbPitrWindow(docker, payload)).rejects.toThrow(/ERROR: Access Denied/);
  });
});
