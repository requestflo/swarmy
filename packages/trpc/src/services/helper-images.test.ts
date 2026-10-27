import { describe, expect, it } from 'bun:test';
import { dataImage } from '@swarmy/core/data-images';
import { buildPlatformManifest, manifestImages } from '@swarmy/core/platform-manifest';
import type { DB } from '@swarmy/db';
import type { AgentHub, CommandName } from '../hub/types';
import { pinHelperImages } from './helper-images';
import { invalidateEffectiveImages } from './platform-images';
import { createRegistryAuthDecorator } from './registry-auth';

// The agent's backup/restore sidecars through the hub dispatch decorator:
// each helper image at the running release's digest, tag kept.
const D = (c: string) => `sha256:${c.repeat(64)}`;
const manifest = buildPlatformManifest({ version: '1.4.0', channel: 'stable', commit: 'c', tag: '1.4.0', digests: { walg: D('a'), postgres17: D('b') } });
const images = manifestImages(manifest);
const RESTIC = `${dataImage('restic').ref}@${dataImage('restic').digest}`;
const WALG = `${dataImage('walg').ref}@${D('a')}`;
const PG = `${dataImage('postgres17').ref}@${D('b')}`;
const repo = { kind: 's3', repo: 's3:http://swarmy-garage:3900/b/p', password: 'p' };
const pin = (cmd: CommandName, p: Record<string, unknown>, imgs?: typeof images) => pinHelperImages(cmd, p, imgs);

describe('pinHelperImages — which field runs which helper', () => {
  it('restic for volume backups, restores, listings and compose-DB dumps', () => {
    for (const cmd of ['backup.run', 'backup.restore', 'backup.list'] as const) {
      expect(pin(cmd, { repo }, images)).toEqual({ repo, image: RESTIC });
    }
    for (const cmd of ['appdb.backup', 'appdb.restore', 'appdb.verify'] as const) {
      expect(pin(cmd, { repo }, images)).toEqual({ repo, resticImage: RESTIC });
    }
  });

  it('managed Postgres: restic + the client for a dump, wal-g only for the wal-g engine', () => {
    expect(pin('db.backup', { engine: 'pg_dump' }, images)).toEqual({ engine: 'pg_dump', resticImage: RESTIC, clientImage: PG });
    expect(pin('db.restore', { engine: 'wal-g', mode: 'pitr' }, images)).toEqual({
      engine: 'wal-g', mode: 'pitr', resticImage: RESTIC, clientImage: PG, engineImage: WALG,
    });
    expect(pin('db.pitrWindow', { engine: 'wal-g' }, images)).toEqual({ engine: 'wal-g', engineImage: WALG });
    expect(pin('db.walVerify', { engine: 'wal-g' }, images)).toEqual({ engine: 'wal-g', engineImage: WALG });
  });

  it("never replaces an image the caller chose (the operator's pgBackRest, a custom restic)", () => {
    const pgbr = { engine: 'pgbackrest', engineImage: 'ops/pgbackrest:2.54' };
    expect(pin('db.backup', pgbr, images).engineImage).toBe('ops/pgbackrest:2.54');
    const custom = { repo, image: 'registry.example.com/restic:0.17.3' };
    expect(pin('backup.run', custom, images)).toBe(custom);
  });

  it('leaves a helper the release pins no digest for absent (the agent default applies), and other commands alone', () => {
    // The compiled BOM pins restic only.
    expect(pin('db.pitrWindow', { engine: 'wal-g' })).toEqual({ engine: 'wal-g' });
    expect(pin('db.backup', { engine: 'wal-g' })).toEqual({ engine: 'wal-g', resticImage: RESTIC });
    const once = { image: dataImage('alpine').ref };
    expect(pin('container.runOnce', once, images)).toBe(once);
  });
});

describe('the hub decorator sends them on every backup dispatch', () => {
  it("reads the org's current release and pins before the command leaves", async () => {
    invalidateEffectiveImages('org-h');
    const db = {
      platformUpgradeRun: { findFirst: async () => null },
      platformConfig: { findUnique: async () => ({ currentManifest: manifest }) },
    } as unknown as DB;
    const decorate = createRegistryAuthDecorator(db, undefined, {} as AgentHub);
    const out = (await decorate('org-h', 'db.restore', { engine: 'wal-g', mode: 'pitr', repo })) as Record<string, unknown>;
    expect([out.engineImage, out.resticImage]).toEqual([WALG, RESTIC]);
    const vol = (await decorate('org-h', 'backup.run', { repo, volume: 'shop_data' })) as Record<string, unknown>;
    expect(vol.image).toBe(RESTIC);
    invalidateEffectiveImages('org-h');
  });
});
