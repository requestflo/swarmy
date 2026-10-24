/**
 * The agent refuses any `container.runOnce` bind outside its allowlist
 * (`@swarmy/core/protocol` run-once-binds). This proves every one-shot payload
 * swarmy builds still passes it, so tightening the allowlist can never quietly
 * break an upgrade, a decommission, a volume copy or a backup-verify drill.
 */
import { describe, expect, it } from 'bun:test';
import { DEFAULT_RESTIC_IMAGE, runOnceBindsRefusal } from '@swarmy/core/protocol';
import { copyVolumePayload } from './engine-upgrade.service';
import { basebackupRunOncePayload } from './manageddb.service';
import { dockerCliPayload } from './platform-upgrade.service';
import { trivyScanRunOnce } from './trivy-db';

const passes = (p: { image: string; binds?: string[]; fallbackImage?: string }) =>
  runOnceBindsRefusal(p.binds, [p.image, p.fallbackImage]);

describe('every swarmy runOnce payload passes the agent bind allowlist', () => {
  it('docker CLI one-shot (platform upgrade, decommission swarm leave) keeps the socket', () => {
    const p = dockerCliPayload('docker swarm leave', {}, 60_000);
    expect(p.binds).toEqual(['/var/run/docker.sock:/var/run/docker.sock']);
    expect(passes(p)).toBeNull();
  });

  it('volume copy, physical Postgres copy, trivy cache: named volumes only', () => {
    expect(passes(copyVolumePayload('swarmy-garage-meta', 'swarmy-garage-meta-backup-r1'))).toBeNull();
    const pg = basebackupRunOncePayload({
      image: 'pgvector/pgvector:pg17',
      primaryService: 'shop_db-primary',
      network: 'shop_db-net',
      dataVolume: 'shop_db-data-1',
      replicationUser: 'replicator',
      replicationPassword: 'pw',
      stamp: '20260101T000000Z',
    });
    expect(passes(pg)).toBeNull();
    expect(passes({ image: 'aquasec/trivy:0.56.2', ...trivyScanRunOnce('nginx:1.27', ['--format', 'json']) })).toBeNull();
  });

  it('backup-verify on a node target: the restic repo, identity-mapped', () => {
    expect(passes({ image: DEFAULT_RESTIC_IMAGE, binds: ['/srv/backups/acme:/srv/backups/acme'] })).toBeNull();
  });

  it('the same builders aimed at the host are refused', () => {
    expect(passes({ ...copyVolumePayload('/', 'x'), image: 'alpine' })).not.toBeNull();
    expect(passes({ ...dockerCliPayload('id', {}, 1000), image: 'alpine:3.20' })).not.toBeNull();
  });
});
