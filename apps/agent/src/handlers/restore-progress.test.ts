import { describe, expect, it } from 'bun:test';
import type { CommandProgress } from '@swarmy/core/protocol';
import { CommandResultPayload } from '@swarmy/core/protocol';
import {
  parseResticRestoreLine,
  parseWalgPitrLine,
  resticRestoreArgs,
  restoreReporter,
  withProgress,
} from './restore-progress';
import { baseBackupSize } from './pitr-restore';

/**
 * A restore reports where it is from lines its sidecars already print:
 * restic's status (JSON on 0.17+, text on 0.16), and the PITR script's own
 * progress lines. Frames are paced within a stage, sent at once on a change,
 * and every frame is a valid `commandResult` running payload.
 */

describe('parseResticRestoreLine', () => {
  it('reads a restic 0.17+ --json status line', () => {
    expect(parseResticRestoreLine('{"message_type":"status","seconds_elapsed":5,"percent_done":0.25,"total_files":4,"files_restored":1,"total_bytes":4000,"bytes_restored":1000}')).toEqual({
      percent: 25,
      bytesDone: 1000,
      bytesTotal: 4000,
    });
  });
  it('reads restic 0.16\'s text status line', () => {
    expect(parseResticRestoreLine('[0:05] 45.12%  12 files 1.200 GiB, total 40 files 2.600 GiB')).toEqual({
      percent: 45.12,
      bytesDone: Math.round(1.2 * 1024 ** 3),
      bytesTotal: Math.round(2.6 * 1024 ** 3),
    });
    expect(parseResticRestoreLine('[1:02:03] 100.00%  1 files 512 B, total 1 files 512 B')).toEqual({ percent: 100, bytesDone: 512, bytesTotal: 512 });
  });
  it('ignores the summary, other JSON and plain text', () => {
    expect(parseResticRestoreLine('{"message_type":"summary","total_bytes":4000}')).toBeNull();
    expect(parseResticRestoreLine('restoring <Snapshot 1a2b3c4d of [/backup]> to /')).toBeNull();
    expect(parseResticRestoreLine('{not json')).toBeNull();
  });
});

describe('parseWalgPitrLine', () => {
  it('base bytes, WAL counts and the final tally', () => {
    expect(parseWalgPitrLine('swarmy: progress base 1048576')).toEqual({ stage: 'base', bytesDone: 1048576 });
    expect(parseWalgPitrLine('swarmy: progress wal 32')).toEqual({ stage: 'wal', segments: 32 });
    expect(parseWalgPitrLine('swarmy: fetched 412 WAL segments (last 0000000100000000000001A0)')).toEqual({ stage: 'wal', segments: 412 });
    expect(parseWalgPitrLine('swarmy: progress base ')).toBeNull();
    expect(parseWalgPitrLine('INFO: 2026/10/24 Selecting the backup with name base_0001')).toBeNull();
  });
});

describe('resticRestoreArgs', () => {
  it('drops --json for a progress restore on restic before 0.17 (it prints no progress under it), keeps it otherwise', () => {
    expect(resticRestoreArgs('restic/restic:0.16.4', 'abc', true)).toEqual(['restore', 'abc', '--target', '/']);
    expect(resticRestoreArgs('restic/restic:0.16.4', 'abc', false)).toEqual(['restore', 'abc', '--target', '/', '--json']);
    expect(resticRestoreArgs('restic/restic:0.17.3', 'abc', true)).toEqual(['restore', 'abc', '--target', '/', '--json']);
    expect(resticRestoreArgs('registry.local/restic@sha256:ab', 'abc', true)).toEqual(['restore', 'abc', '--target', '/', '--json']);
  });
});

describe('restoreReporter', () => {
  function rig() {
    let t = 0;
    const sent: CommandProgress[] = [];
    const r = restoreReporter((p) => sent.push(p), () => t, 2_000);
    return { r, sent, tick: (ms: number) => (t += ms) };
  }

  it('says nothing before the first stage; a stage goes at once, lines within it are paced', () => {
    const { r, sent, tick } = rig();
    r.line('[0:01] 1.00%  0 files 1 B, total 1 files 100 B');
    expect(sent).toEqual([]);
    r.stage('download');
    r.line('[0:01] 10.00%  0 files 10 B, total 1 files 100 B');
    tick(2_500);
    r.line('[0:03] 40.00%  0 files 40 B, total 1 files 100 B');
    expect(sent).toEqual([
      { phase: 'restoring', restore: { stage: 'download' } },
      { phase: 'restoring', restore: { stage: 'download', percent: 40, bytesDone: 40, bytesTotal: 100 } },
    ]);
    r.stage('load', { bytesTotal: 100 });
    expect(sent.at(-1)).toEqual({ phase: 'restoring', restore: { stage: 'load', bytesTotal: 100 } });
  });

  it('the PITR script moves base → wal at once, keeping the base total until then', () => {
    const { r, sent, tick } = rig();
    r.stage('base', { bytesTotal: 4000 });
    tick(5_000);
    r.line('swarmy: progress base 1000');
    expect(sent.at(-1)!.restore).toEqual({ stage: 'base', bytesTotal: 4000, bytesDone: 1000 });
    r.line('swarmy: progress wal 0');
    expect(sent.at(-1)!.restore).toEqual({ stage: 'wal', segments: 0 });
    expect(sent.every((p) => CommandResultPayload.safeParse({ commandId: '00000000-0000-4000-8000-000000000091', status: 'running', progress: p }).success)).toBe(true);
  });

  it('withProgress keeps the log line and feeds the reporter; without one it is the log line alone', () => {
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    expect(withProgress(log, null)).toBe(log);
    const { r, sent } = rig();
    r.stage('base');
    withProgress(log, r)('swarmy: progress wal 0');
    expect(lines).toEqual(['swarmy: progress wal 0']);
    expect(sent.at(-1)!.restore!.stage).toBe('wal');
  });
});

describe('baseBackupSize', () => {
  const LIST = JSON.stringify([
    { backup_name: 'base_A', finish_time: '2026-10-20T03:00:00Z', uncompressed_size: 4000 },
    { backup_name: 'base_B', finish_time: '2026-10-22T03:00:00Z', uncompressed_size: 5000 },
  ]);
  it('the named backup, or the newest for LATEST; nothing when the list says nothing', () => {
    expect(baseBackupSize(LIST, 'base_A')).toBe(4000);
    expect(baseBackupSize(LIST, 'LATEST')).toBe(5000);
    expect(baseBackupSize(LIST, 'base_C')).toBeUndefined();
    expect(baseBackupSize('nope', 'LATEST')).toBeUndefined();
  });
});
