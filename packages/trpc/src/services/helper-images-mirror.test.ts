import { describe, expect, it } from 'bun:test';
import { dataImage } from '@swarmy/core/data-images';
import { buildPlatformManifest, manifestImages } from '@swarmy/core/platform-manifest';
import { MIRROR_NODE_LABEL, mirrorLabelKey } from '@swarmy/core/system-images';
import type { CommandName } from '../hub/types';
import { HELPER_IMAGE_COMMANDS, pinHelperImages } from './helper-images';
import { HELPER_FIELDS, helperImagesOf } from './helper-images-mirror';
import { dispatchImages } from './registry-auth';
import { rewriteSystemImages, type MirrorState } from './system-images.service';

// Backup/restore/dump sidecars from the in-cluster mirror: the helper fields
// arrive pinned at the release's digests (pinHelperImages), and a trusted
// mirror turns each into its copy, tag kept, with upstream as the fallback.
const H = 'localhost:5000';
const D = (c: string) => `sha256:${c.repeat(64)}`;
const images = manifestImages(
  buildPlatformManifest({ version: '1.4.0', channel: 'stable', commit: 'c', tag: '1.4.0', digests: { walg: D('a'), postgres17: D('b') } }),
);
const restic = dataImage('restic');
const walg = dataImage('walg');
const pg = dataImage('postgres17');
const RESTIC = `${restic.ref}@${restic.digest}`;
const WALG = `${walg.ref}@${D('a')}`;
const PG = `${pg.ref}@${D('b')}`;
const M_RESTIC = `${H}/swarmy-system/docker.io/restic/restic:0.16.4@${restic.digest}`;
const M_WALG = `${H}/swarmy-system/ghcr.io/requestflo/swarmy-walg:latest@${D('a')}`;
const M_PG = `${H}/swarmy-system/docker.io/pgvector/pgvector:pg17@${D('b')}`;
const labels = {
  [mirrorLabelKey('restic')]: RESTIC,
  [mirrorLabelKey('walg')]: WALG,
  [mirrorLabelKey('postgres17')]: PG,
  [MIRROR_NODE_LABEL]: 'swarm-n1',
};
const state: MirrorState = { labels, registryNodeId: 'swarm-n1', registry: undefined };
const repo = { kind: 's3', repo: 's3:http://swarmy-garage:3900/b/p', password: 'p' };

/** What the decorator does: pin at the release digests, then mirror. */
const send = (cmd: CommandName, p: Record<string, unknown>, s: MirrorState = state) =>
  rewriteSystemImages(cmd, pinHelperImages(cmd, p, images), H, s, images) as Record<string, unknown>;

describe('rewriteSystemImages — every backup/restore/dump command pulls through the mirror', () => {
  it('restic for volume backups, restores and listings: image → copy, fallbackImage → upstream', () => {
    for (const cmd of ['backup.run', 'backup.restore', 'backup.list'] as const) {
      expect(send(cmd, { repo })).toEqual({ repo, image: M_RESTIC, fallbackImage: RESTIC });
    }
  });

  it('restic for compose-DB dumps, restores and verify drills (the app engine image stays)', () => {
    for (const cmd of ['appdb.backup', 'appdb.restore'] as const) {
      expect(send(cmd, { repo })).toEqual({ repo, resticImage: M_RESTIC, fallbackResticImage: RESTIC });
    }
    const verify = send('appdb.verify', { repo, image: PG });
    expect(verify).toEqual({ repo, image: PG, resticImage: M_RESTIC, fallbackResticImage: RESTIC });
  });

  it('managed Postgres: restic + the client for a dump, wal-g too for a wal-g backup or PITR', () => {
    expect(send('db.backup', { engine: 'pg_dump' })).toEqual({
      engine: 'pg_dump', resticImage: M_RESTIC, fallbackResticImage: RESTIC, clientImage: M_PG, fallbackClientImage: PG,
    });
    expect(send('db.restore', { engine: 'wal-g', mode: 'pitr' })).toEqual({
      engine: 'wal-g', mode: 'pitr',
      resticImage: M_RESTIC, fallbackResticImage: RESTIC,
      clientImage: M_PG, fallbackClientImage: PG,
      engineImage: M_WALG, fallbackEngineImage: WALG,
    });
    for (const cmd of ['db.pitrWindow', 'db.walVerify'] as const) {
      expect(send(cmd, { engine: 'wal-g' })).toEqual({ engine: 'wal-g', engineImage: M_WALG, fallbackEngineImage: WALG });
    }
  });

  it("the operator's pgBackRest, another digest and an unmirrored helper keep their upstream ref", () => {
    const pgbr = send('db.backup', { engine: 'pgbackrest', engineImage: 'ops/pgbackrest:2.54' });
    expect([pgbr.engineImage, pgbr.fallbackEngineImage, pgbr.resticImage]).toEqual(['ops/pgbackrest:2.54', undefined, M_RESTIC]);
    const other = { repo, image: `${restic.ref}@${D('0')}` };
    expect(rewriteSystemImages('backup.run', other, H, state, images)).toBe(other);
    const noWalg = { ...state, labels: { ...labels, [mirrorLabelKey('walg')]: '' } };
    expect(send('db.pitrWindow', { engine: 'wal-g' }, noWalg)).toEqual({ engine: 'wal-g', engineImage: WALG });
  });

  it('an untrusted mirror (moved registry, none running) changes nothing: same reference', () => {
    const p = pinHelperImages('backup.run', { repo }, images);
    expect(rewriteSystemImages('backup.run', p, H, { ...state, registryNodeId: 'swarm-n2' }, images)).toBe(p);
    expect(rewriteSystemImages('backup.run', p, H, { ...state, registryNodeId: null }, images)).toBe(p);
  });

  it("is idempotent and never replaces a caller's fallback", () => {
    const once = send('backup.run', { repo });
    expect(rewriteSystemImages('backup.run', once, H, state, images)).toBe(once);
    const own = send('backup.run', { repo, fallbackImage: 'mirror.corp/restic:0.16.4' });
    expect([own.image, own.fallbackImage]).toEqual([M_RESTIC, 'mirror.corp/restic:0.16.4']);
  });
});

describe('the helper field table', () => {
  it('covers exactly the commands whose sidecars are digest-pinned', () => {
    const all: CommandName[] = ['appdb.backup', 'appdb.restore', 'appdb.verify', 'backup.list', 'backup.restore', 'backup.run'];
    all.push('db.backup', 'db.pitrWindow', 'db.restore', 'db.walVerify');
    expect([...HELPER_IMAGE_COMMANDS].sort()).toEqual(all);
    for (const cmd of HELPER_IMAGE_COMMANDS) {
      const pinned = pinHelperImages(cmd, { engine: 'wal-g' }, images) as Record<string, unknown>;
      const filled = Object.keys(pinned).filter((k) => k !== 'engine');
      expect(filled.every((f) => HELPER_FIELDS[cmd]!.includes(f as never))).toBe(true);
    }
  });

  it('the mirrored copies are what a sidecar dispatch pulls (so they get the login)', () => {
    const out = send('db.backup', { engine: 'wal-g' });
    expect(helperImagesOf('db.backup', out)).toEqual([M_RESTIC, M_PG, M_WALG]);
    expect(dispatchImages('db.backup', out)).toEqual([M_RESTIC, M_PG, M_WALG]);
    expect(dispatchImages('appdb.verify', { image: 'mysql:8' })).toEqual([]);
  });
});
