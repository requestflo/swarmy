import { describe, expect, it } from 'bun:test';
import { dataImage } from '../data-images';
import { buildPlatformManifest, manifestImages } from '../platform-manifest';
import { BackupVolumePayload, RestoreVolumePayload } from './backup';
import { DbBackupPayload } from './dbBackup';
import { helperDefault, helperImage, pinnedHelperRefs } from './helper-images';
import { DbPitrWindowPayload } from './pitrWindow';

const D = (c: string) => `sha256:${c.repeat(64)}`;
const restic = dataImage('restic');
const walg = dataImage('walg');
const pg17 = dataImage('postgres17');
const release = manifestImages(
  buildPlatformManifest({ version: '1.4.0', channel: 'stable', commit: 'c', tag: '1.4.0', digests: { walg: D('a'), postgres17: D('b') } }),
);

describe('pinnedHelperRefs — the controller side, at the release digests', () => {
  it('pins every helper the release has a digest for, tag kept', () => {
    expect(pinnedHelperRefs(release)).toEqual({
      restic: `${restic.ref}@${restic.digest}`,
      walg: `${walg.ref}@${D('a')}`,
      pgClient: `${pg17.ref}@${D('b')}`,
    });
  });

  it('leaves out a helper with no digest (the agent then uses its own default, never a floating tag)', () => {
    expect(pinnedHelperRefs()).toEqual({ restic: `${restic.ref}@${restic.digest}` });
  });
});

describe('helperImage — the agent side', () => {
  const pinned = `${walg.ref}@${D('a')}`;

  it("runs the controller's digest-pinned ref", () => {
    expect(helperImage('walg', pinned)).toBe(pinned);
  });

  it('falls back to its own default when an older controller sends nothing or the bare tag', () => {
    expect(helperImage('restic', undefined)).toBe(`restic/restic:0.16.4@${restic.digest}`);
    expect(helperImage('restic', restic.ref)).toBe(helperDefault('restic'));
    expect(helperImage('walg', walg.ref)).toBe(walg.ref); // compiled BOM has no wal-g digest
    expect(helperImage('pgClient', ' ')).toBe(pg17.ref);
  });

  it("keeps an operator's own image as sent", () => {
    expect(helperImage('restic', 'registry.example.com/restic:0.17.3')).toBe('registry.example.com/restic:0.17.3');
  });
});

describe('the pinned refs ride fields the payloads already carry (additive)', () => {
  const repo = { kind: 's3' as const, repo: 's3:http://swarmy-garage:3900/b/p', password: 'p' };
  const commandId = '00000000-0000-4000-8000-000000000001';
  const walgPinned = `${walg.ref}@${D('a')}`;

  it('parses with and without them', () => {
    const base = { commandId, jobId: 'j1', repo, volume: 'shop_data' };
    expect(BackupVolumePayload.parse(base).image).toBeUndefined();
    expect(BackupVolumePayload.parse({ ...base, image: helperDefault('restic') }).image).toBe(helperDefault('restic'));
    const restore = RestoreVolumePayload.parse({ commandId, repo, targetVolume: 'v', image: helperDefault('restic') });
    expect(restore.image).toContain('@sha256:');
    const db = DbBackupPayload.parse({
      commandId, jobId: 'j3', engine: 'pg_dump', repo, conn: { host: 'h', password: 'x' },
      resticImage: helperDefault('restic'), clientImage: `${pg17.ref}@${D('b')}`,
    });
    expect([db.resticImage, db.clientImage]).toEqual([helperDefault('restic'), `${pg17.ref}@${D('b')}`]);
    expect(DbPitrWindowPayload.parse({ commandId, engine: 'wal-g', repo, engineImage: walgPinned }).engineImage).toBe(walgPinned);
  });
});
