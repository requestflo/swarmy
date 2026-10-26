import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import type { DbWalVerifyPayload } from '@swarmy/core/protocol';
import { LISTING_END, VERIFY_END, dbWalVerify, parseWalVerifyJson, parseWalVerifyOutput, timeRanges, walVerifyScript } from './wal-verify';

/**
 * The WAL check reads the archive and asks the primary only for its current
 * segment: wal-verify's ranges come back with a time on each end, so a gap
 * reads as "13:10 to 13:25", and the password reaches the sidecar only as a
 * file, never as env.
 */

const REPORT = JSON.stringify({
  integrity: {
    status: 'FAILURE',
    details: [
      { timeline_id: 1, start_segment: '000000010000000000000002', end_segment: '000000010000000000000009', segments_count: 8, status: 'FOUND' },
      { timeline_id: 1, start_segment: '00000001000000000000000A', end_segment: '00000001000000000000000B', segments_count: 2, status: 'MISSING_LOST' },
      { timeline_id: 1, start_segment: '00000001000000000000000C', end_segment: '00000001000000000000000D', segments_count: 2, status: 'FOUND' },
      { timeline_id: 1, start_segment: '00000001000000000000000E', end_segment: '00000001000000000000000E', segments_count: 1, status: 'MISSING_UPLOADING' },
    ],
  },
  timeline: { status: 'OK', details: { current_timeline_id: 1, highest_storage_timeline_id: 1 } },
});
const LISTING = [
  'type size last modified                    name',
  'obj  1024 2026-10-21 03:00:00 +0000 UTC wal_005/000000010000000000000002.lz4',
  'obj  1024 2026-10-21 13:10:00 +0000 UTC wal_005/000000010000000000000009.lz4',
  'obj  1024 2026-10-21 13:25:00 +0000 UTC wal_005/00000001000000000000000C.lz4',
  'obj  1024 2026-10-24 09:15:00 +0000 UTC wal_005/00000001000000000000000D.lz4',
].join('\n');
const LIST = JSON.stringify([{ backup_name: 'base_000000010000000000000002', finish_time: '2026-10-21T03:00:00Z' }]);
const OUT = `${REPORT}\n${VERIFY_END} 0\n${LISTING}\n${LISTING_END}\n${LIST}`;

describe('parseWalVerifyJson', () => {
  it('reads the integrity verdict, each range and the timeline check', () => {
    const r = parseWalVerifyJson(REPORT)!;
    expect(r.integrity).toBe('failure');
    expect(r.ranges.map((x) => x.status)).toEqual(['found', 'lost', 'found', 'uploading']);
    expect(r.ranges[1]).toEqual({ timeline: 1, startSegment: '00000001000000000000000A', endSegment: '00000001000000000000000B', segments: 2, status: 'lost' });
    expect(r.timeline).toEqual({ status: 'ok', current: 1, highestInStorage: 1 });
  });
  it('a report with no details is OK and empty; text that is not a report is null', () => {
    expect(parseWalVerifyJson('{"integrity":{"status":"OK","details":null}}')).toEqual({ integrity: 'ok', ranges: [] });
    expect(parseWalVerifyJson('ERROR: failed to connect')).toBeNull();
    expect(parseWalVerifyJson('{"integrity":{"status":"MAYBE"}}')).toBeNull();
  });
});

describe('timeRanges', () => {
  it('a found range spans its own uploads; a gap spans the found segments on either side', () => {
    const ranges = timeRanges(parseWalVerifyJson(REPORT)!.ranges, new Map([
      ['000000010000000000000002', Date.parse('2026-10-21T03:00:00Z')],
      ['000000010000000000000009', Date.parse('2026-10-21T13:10:00Z')],
      ['00000001000000000000000C', Date.parse('2026-10-21T13:25:00Z')],
      ['00000001000000000000000D', Date.parse('2026-10-24T09:15:00Z')],
    ]));
    expect(ranges[0]).toMatchObject({ from: '2026-10-21T03:00:00.000Z', to: '2026-10-21T13:10:00.000Z' });
    expect(ranges[1]).toMatchObject({ status: 'lost', from: '2026-10-21T13:10:00.000Z', to: '2026-10-21T13:25:00.000Z' });
    // the newest segments are still on their way: after the last found one, no end yet
    expect(ranges[3]).toEqual({ timeline: 1, startSegment: '00000001000000000000000E', endSegment: '00000001000000000000000E', segments: 1, status: 'uploading', from: '2026-10-24T09:15:00.000Z' });
  });
});

describe('parseWalVerifyOutput', () => {
  it('splits the report, the listing and the base backups', () => {
    const r = parseWalVerifyOutput(OUT, '', '2026-10-24T09:20:00.000Z');
    expect(r.integrity).toBe('failure');
    expect(r.ranges[1]).toMatchObject({ from: '2026-10-21T13:10:00.000Z', to: '2026-10-21T13:25:00.000Z' });
    expect(r.backups).toEqual([{ name: 'base_000000010000000000000002', finishTime: '2026-10-21T03:00:00.000Z' }]);
    expect(r.checkedAt).toBe('2026-10-24T09:20:00.000Z');
  });
  it('no report: the failure says why, from the tail of stderr', () => {
    expect(() => parseWalVerifyOutput(`${VERIFY_END} 1\n${LISTING_END}\n`, 'INFO: x\nERROR: failed to connect to `host=shop_main-primary`\n', 'x')).toThrow(
      /failed to connect/,
    );
  });
});

function fakeDocker(out: { stdout?: string; stderr?: string; exit?: number }) {
  const created: Array<{ Cmd: string[]; Env: string[]; HostConfig: { Binds: string[]; NetworkMode?: string } }> = [];
  const files: string[] = [];
  const docker = {
    pullImage: async () => undefined,
    docker: {
      getImage: () => ({ inspect: async () => ({ Config: {} }) }),
      getNetwork: () => ({ connect: async () => undefined }),
      modem: {
        demuxStream: (_s: unknown, o: { write(b: Buffer): void }, e: { write(b: Buffer): void }) => {
          if (out.stdout) o.write(Buffer.from(out.stdout));
          if (out.stderr) e.write(Buffer.from(out.stderr));
        },
      },
      createContainer: async (o: (typeof created)[number]) => {
        created.push(o);
        return {
          id: 'c1',
          putArchive: async (tar: Buffer) => void files.push(tar.toString('latin1')),
          attach: async () => ({}),
          start: async () => undefined,
          wait: async () => ({ StatusCode: out.exit ?? 0 }),
          kill: async () => undefined,
          remove: async () => undefined,
        };
      },
    },
  } as unknown as DockerClient;
  return { docker, created, files };
}

const payload: DbWalVerifyPayload = {
  commandId: 'c1',
  engine: 'wal-g',
  repo: { kind: 's3', repo: 's3:http://swarmy-garage:3900/bkt/pfx', password: 'rp', accessKeyId: 'AK', secretAccessKey: 'SK' },
  conn: { host: 'shop_main-primary', port: 5432, user: 'postgres', password: 's3cret-pw', database: 'app' },
  network: 'shop_main-net',
  resticNetwork: 'swarmy',
};

describe('dbWalVerify', () => {
  it('runs wal-verify with no volume, the primary in libpq env and the password only as a file', async () => {
    const { docker, created, files } = fakeDocker({ stdout: OUT });
    const r = await dbWalVerify(docker, payload, () => Date.parse('2026-10-24T09:20:00Z'));
    expect(created[0]!.Cmd).toEqual([walVerifyScript()]);
    expect(created[0]!.Cmd[0]).toContain('wal-g wal-verify integrity timeline --json');
    expect(created[0]!.HostConfig.Binds).toEqual([]);
    expect(created[0]!.Env).toContain('PGHOST=shop_main-primary');
    expect(created[0]!.Env.join('\n')).not.toContain('s3cret-pw');
    expect(files.join('')).toContain('s3cret-pw');
    expect(created[0]!.HostConfig.NetworkMode).toBe('shop_main-net');
    expect(r.integrity).toBe('failure');
  });
  it('an unreachable destination (the preflight) fails with its own words', async () => {
    const { docker } = fakeDocker({ stderr: 'swarmy: the backup destination host swarmy-garage does not resolve\n', exit: 3 });
    await expect(dbWalVerify(docker, payload)).rejects.toThrow(/does not resolve/);
  });
});
