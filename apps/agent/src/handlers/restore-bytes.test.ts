import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import { parseStatsSize, restoredBytes, restoredBytesFromSummary } from './backup';

/** A DockerClient double whose one-shot sidecar prints `stdout` (records its args). */
function sidecarDocker(stdout: string, exit = 0) {
  const calls: string[][] = [];
  const docker = {
    pullImage: async () => '',
    docker: {
      createContainer: async (o: { Cmd: string[] }) => {
        calls.push(o.Cmd);
        return {
          attach: async () => ({}),
          start: async () => undefined,
          wait: async () => ({ StatusCode: exit }),
          remove: async () => undefined,
        };
      },
      modem: {
        demuxStream: (_s: unknown, out: { write(b: Buffer): void }) => out.write(Buffer.from(stdout)),
      },
    },
  } as unknown as DockerClient;
  return { docker, calls };
}

const repo = { url: 's3:https://s3.example/bucket', password: 'pw', env: {} } as never;
const q = { image: 'restic/restic:0.16.4', repo, snapshotId: 'a1b2c3d4' };

describe('restored bytes (QA-004)', () => {
  it('restic ≥0.17 summary line wins (bytes_restored, else total_bytes)', () => {
    expect(restoredBytesFromSummary('{"message_type":"status"}\n{"message_type":"summary","total_bytes":900,"bytes_restored":812}\n')).toBe(812);
    expect(restoredBytesFromSummary('{"message_type":"summary","total_bytes":900}')).toBe(900);
  });

  it('restic 0.16 prints no JSON summary for restore → null', () => {
    expect(restoredBytesFromSummary('restoring <Snapshot a1b2c3d4 of [/data]> to /\n')).toBeNull();
    expect(restoredBytesFromSummary('')).toBeNull();
  });

  it('parseStatsSize reads restore-size stats', () => {
    expect(parseStatsSize('{"total_size":412331520,"total_file_count":17,"snapshots_count":1}\n')).toBe(412331520);
    expect(parseStatsSize('nope')).toBeNull();
  });

  it('no summary: asks restic for the snapshot restore size (not "0 bytes")', async () => {
    const { docker, calls } = sidecarDocker('{"total_size":412331520,"total_file_count":17}\n');
    expect(await restoredBytes(docker, 'restoring <Snapshot a1b2c3d4> to /\n', q)).toBe(412331520);
    expect(calls[0]).toEqual(['stats', 'a1b2c3d4', '--json', '--mode', 'restore-size']);
  });

  it('a summary needs no extra restic call; a failed stats call degrades to 0', async () => {
    const s = sidecarDocker('');
    expect(await restoredBytes(s.docker, '{"message_type":"summary","bytes_restored":5}', q)).toBe(5);
    expect(s.calls).toHaveLength(0);
    expect(await restoredBytes(sidecarDocker('boom', 1).docker, '', q)).toBe(0);
  });
});
