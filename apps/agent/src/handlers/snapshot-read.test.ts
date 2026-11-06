import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import { dataImage } from '@swarmy/core/data-images';
import { DEFAULT_RESTIC_IMAGE } from '@swarmy/core/protocol';
import { dumpArgs, lsArgs, prepareRead, readSidecar } from './snapshot-read';
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

  it('its mirrored copy is restic too, and so must its fallback be', () => {
    expect(readSidecar({ repo: S3, image: MIRROR, fallbackImage: UP }).image).toBe(MIRROR);
    expect(() => readSidecar({ repo: S3, image: 'localhost:5000/swarmy-system/docker.io/library/alpine:3' })).toThrow('only the restic image');
    expect(() => readSidecar({ repo: S3, image: MIRROR, fallbackImage: 'alpine:3' })).toThrow('only the restic image');
  });
});

// A mirrored read image: the in-cluster copy with the mirror login, then upstream.
const UP = `${dataImage('restic').ref}@${dataImage('restic').digest}`;
const MIRROR = `localhost:5000/swarmy-system/docker.io/restic/restic:0.16.4@${dataImage('restic').digest}`;
const AUTH = { username: 'swarmy', password: 'pw', server: 'localhost:5000' };

/** Docker that can pull `pullable` (only with a login for the mirror) and has `present` on the node. */
function fakeDocker(o: { pullable?: string[]; present?: string[] } = {}) {
  const pulls: { ref: string; auth: boolean }[] = [];
  const on = new Set(o.present ?? []);
  const docker = {
    pullImage: async (ref: string, auth?: unknown) => {
      pulls.push({ ref, auth: !!auth });
      if (!(o.pullable ?? []).includes(ref) || (ref === MIRROR && !auth)) throw new Error(`pull ${ref} failed`);
      on.add(ref);
    },
    docker: {
      getImage: (ref: string) => ({
        inspect: async () => {
          if (!on.has(ref)) throw new Error('no such image');
          return {};
        },
      }),
    },
  };
  return { docker: docker as unknown as DockerClient, pulls };
}

describe('prepareRead (pulling the read image)', () => {
  it('pulls the mirrored copy with the login, and the sidecar does not pull it again', async () => {
    const d = fakeDocker({ pullable: [MIRROR, UP] });
    const sc = await prepareRead(d.docker, { repo: S3, image: MIRROR, fallbackImage: UP, registryAuth: AUTH });
    expect(sc.image).toBe(MIRROR);
    expect(sc.pull).toBe(false);
    expect(d.pulls).toEqual([{ ref: MIRROR, auth: true }]);
  });

  it('runs upstream when the mirror can’t serve it', async () => {
    const d = fakeDocker({ pullable: [UP] });
    const sc = await prepareRead(d.docker, { repo: S3, image: MIRROR, fallbackImage: UP, registryAuth: AUTH });
    expect(sc.image).toBe(UP);
    expect(d.pulls.map((p) => p.ref)).toEqual([MIRROR, UP]);
  });

  it('an older controller sends neither: nothing pulled here, the sidecar pulls as before', async () => {
    const d = fakeDocker({ pullable: [UP] });
    const sc = await prepareRead(d.docker, { repo: S3, image: UP });
    expect(sc).toMatchObject({ image: UP, pull: true });
    expect(d.pulls).toEqual([]);
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
