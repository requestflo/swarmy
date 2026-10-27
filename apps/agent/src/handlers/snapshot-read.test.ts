import { describe, expect, it } from 'bun:test';
import { DEFAULT_RESTIC_IMAGE } from '@swarmy/core/protocol';
import { dumpArgs, lsArgs, readSidecar } from './snapshot-read';
import { foldLs, parseLsLine } from './snapshot-ls';

const S3 = { kind: 's3' as const, repo: 's3:https://s3.example.com/b', password: 'pw', accessKeyId: 'AK', secretAccessKey: 'SK' };

describe('readSidecar (how restic reads a save)', () => {
  it('credentials are container env only; an S3 repo needs no bind', () => {
    const sc = readSidecar({ repo: S3, network: 'swarmy' });
    expect(sc).toEqual({
      image: DEFAULT_RESTIC_IMAGE,
      env: ['RESTIC_REPOSITORY=s3:https://s3.example.com/b', 'RESTIC_PASSWORD=pw', 'AWS_ACCESS_KEY_ID=AK', 'AWS_SECRET_ACCESS_KEY=SK'],
      binds: [],
      networkMode: 'swarmy',
    });
  });

  it('a node-path repo is mounted read-only, and never a system path', () => {
    expect(readSidecar({ repo: { kind: 'node', repo: '/srv/backups/x', password: 'pw' } }).binds).toEqual(['/srv/backups/x:/srv/backups/x:ro']);
    expect(() => readSidecar({ repo: { kind: 'node', repo: '/etc', password: 'pw' } })).toThrow('system path');
    expect(() => readSidecar({ repo: { kind: 'node', repo: '/srv/a:/x', password: 'pw' } })).toThrow('plain absolute path');
  });

  it('runs only the restic image', () => {
    expect(() => readSidecar({ repo: S3, image: 'alpine:3' })).toThrow('only the restic image');
  });
});

describe('restic argv', () => {
  it('dump: --no-lock, a tar for a folder, the bytes for a file, options ended before the ids', () => {
    expect(dumpArgs({ snapshotId: 'abc', path: '/data/sub', kind: 'dir' })).toEqual(['--no-lock', 'dump', '--archive', 'tar', '--', 'abc', '/data/sub']);
    expect(dumpArgs({ snapshotId: 'abc', path: '/data/a.txt', kind: 'file' })).toEqual(['--no-lock', 'dump', '--', 'abc', '/data/a.txt']);
    expect(() => dumpArgs({ snapshotId: '-x', path: '/data', kind: 'dir' })).toThrow('unsafe snapshot id');
  });
  it('ls: json, non-recursive', () => {
    expect(lsArgs({ snapshotId: 'latest', path: '/data' })).toEqual(['--no-lock', 'ls', '--json', '--', 'latest', '/data']);
  });
});

describe('restic ls --json parsing (restic 0.16.4 lines)', () => {
  const snapshotLine = '{"time":"2026-10-27T15:30:18Z","paths":["/data"],"id":"e1a3","short_id":"e1a3","struct_type":"snapshot"}';
  const lines = [
    snapshotLine,
    '{"name":"data","type":"dir","path":"/data","mtime":"2026-10-27T15:30:15Z","struct_type":"node"}',
    '{"name":"a.txt","type":"file","path":"/data/a.txt","size":6,"mtime":"2026-10-27T15:30:15Z","struct_type":"node"}',
    '{"name":"link","type":"symlink","path":"/data/link","struct_type":"node"}',
    '{"name":"sub","type":"dir","path":"/data/sub","message_type":"node"}',
  ];

  it('skips the snapshot line and junk, keeps sizes for files', () => {
    expect(parseLsLine(snapshotLine)).toBeNull();
    expect(parseLsLine('not json')).toBeNull();
    expect(parseLsLine(lines[2]!)).toEqual({ path: '/data/a.txt', name: 'a.txt', type: 'file', size: 6, mtime: '2026-10-27T15:30:15Z' });
  });

  it('folds into the path itself and its children, folders first, cut at the limit', () => {
    const entries = lines.map(parseLsLine).filter((e) => e !== null);
    const r = foldLs('/data', entries, 500);
    expect(r.node?.type).toBe('dir');
    expect(r.entries.map((e) => e.name)).toEqual(['sub', 'a.txt', 'link']);
    expect(r.truncated).toBe(false);
    expect(foldLs('/data', entries, 2)).toMatchObject({ truncated: true, entries: [{ name: 'sub' }, { name: 'a.txt' }] });
  });

  it('a file has no children; a missing path has no node', () => {
    const file = parseLsLine(lines[2]!)!;
    expect(foldLs('/data/a.txt', [file], 500)).toEqual({ node: file, entries: [], truncated: false });
    expect(foldLs('/data/nope', [], 500)).toEqual({ node: null, entries: [], truncated: false });
  });
});
