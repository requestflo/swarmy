import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { encryptSecret } from '@swarmy/core/crypto';
import { dataImage } from '@swarmy/core/data-images';
import { buildPlatformManifest } from '@swarmy/core/platform-manifest';
import { AGENT_CAPABILITY } from '@swarmy/core/protocol';
import { MIRROR_NODE_LABEL, mirrorLabelKey } from '@swarmy/core/system-images';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import { agentTakesMirroredHelpers } from './helper-images-mirror';
import { invalidateEffectiveImages } from './platform-images';
import { createRegistryAuthDecorator } from './registry-auth';
import { invalidateRegistryCredentialCache } from './registry-credentials.service';
import { seedKv } from './swarm-kv.service';

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-helper-images-mirror-0123456789';

// The hub decorator: a backup dispatch to an agent that advertises
// `helperImageMirror` pulls its sidecar from the mirror (with the in-swarm
// login and the upstream fallback); any other agent keeps the upstream ref.
const ORG = 'org-hm';
const D = (c: string) => `sha256:${c.repeat(64)}`;
const manifest = buildPlatformManifest({ version: '1.4.0', channel: 'stable', commit: 'c', tag: '1.4.0', digests: { walg: D('a') } });
const restic = dataImage('restic');
const walg = dataImage('walg');
const RESTIC = `${restic.ref}@${restic.digest}`;
const M_RESTIC = `localhost:5000/swarmy-system/docker.io/restic/restic:0.16.4@${restic.digest}`;
const LOGIN = { username: 'swarmy', password: 'pw', server: 'localhost:5000' };
const repo = { kind: 's3', repo: 's3:http://swarmy-garage:3900/b/p', password: 'p' };

function fixture() {
  const hub = {
    agentBuildFor: (id: string) =>
      id === 'n-new' ? { version: '1.4.0', capabilities: [AGENT_CAPABILITY.helperImageMirror] } : { version: '1.3.0', capabilities: [] },
  } as unknown as AgentHub;
  seedKv(hub, ORG, 'registry', ORG, {
    enabled: true,
    host: 'localhost:5000',
    credentialsEnc: encryptSecret(JSON.stringify({ username: 'swarmy', password: 'pw' })),
  });
  const db = {
    platformUpgradeRun: { findFirst: async () => null },
    platformConfig: { findUnique: async () => ({ currentManifest: manifest }) },
    // A Docker Hub login the org keeps for its own images: never sent with a sidecar.
    registryCredential: {
      findMany: async () => [{ prefix: 'docker.io', username: 'hub', secretEnc: encryptSecret('tok') }],
    },
  } as unknown as DB;
  const live = () => ({
    services: [{ id: 'sid', name: 'swarmy-registry', labels: {
      [mirrorLabelKey('restic')]: RESTIC,
      [mirrorLabelKey('walg')]: `${walg.ref}@${D('a')}`,
      [MIRROR_NODE_LABEL]: 'swarm-n1',
    } }],
    containers: [{ state: 'running', serviceId: 'sid', labels: { 'com.docker.swarm.node.id': 'swarm-n1' } }],
  }) as never;
  return createRegistryAuthDecorator(db, live, hub);
}

beforeEach(() => {
  invalidateEffectiveImages(ORG);
  invalidateRegistryCredentialCache();
});
afterEach(() => invalidateEffectiveImages(ORG));

describe('the hub decorator × mirrored sidecar images', () => {
  it('an agent that advertises helperImageMirror gets the copy, the upstream fallback and the mirror login', async () => {
    const out = (await fixture()(ORG, 'backup.run', { repo, volume: 'shop_data' }, 'n-new')) as Record<string, unknown>;
    expect(out).toMatchObject({ image: M_RESTIC, fallbackImage: RESTIC, registryAuth: LOGIN });
    const pitr = (await fixture()(ORG, 'db.restore', { engine: 'wal-g', mode: 'pitr', repo }, 'n-new')) as Record<string, unknown>;
    expect(pitr).toMatchObject({
      engineImage: `localhost:5000/swarmy-system/ghcr.io/requestflo/swarmy-walg:latest@${D('a')}`,
      fallbackEngineImage: `${walg.ref}@${D('a')}`,
      registryAuth: LOGIN,
    });
  });

  it('an older agent, or an unknown node, keeps the upstream ref and gets no login at all', async () => {
    for (const node of ['n-old', undefined]) {
      const out = (await fixture()(ORG, 'backup.run', { repo, volume: 'shop_data' }, node)) as Record<string, unknown>;
      expect(out.image).toBe(RESTIC);
      expect(out.fallbackImage).toBeUndefined();
      expect(out.registryAuth).toBeUndefined();
    }
  });

  it('other commands still get their mirror rewrite and third-party login as before', async () => {
    const out = (await fixture()(ORG, 'image.pull', { image: 'me/private:1' }, 'n-new')) as { registryAuth?: { username: string } };
    expect(out.registryAuth?.username).toBe('hub');
  });
});

describe('agentTakesMirroredHelpers', () => {
  it('needs a node and an agent that advertised the capability', () => {
    const hub = { agentBuildFor: (id: string) => (id === 'a' ? { version: '1', capabilities: ['helperImageMirror'] } : undefined) };
    expect(agentTakesMirroredHelpers(hub as never, 'a')).toBe(true);
    expect(agentTakesMirroredHelpers(hub as never, 'b')).toBe(false);
    expect(agentTakesMirroredHelpers(hub as never, undefined)).toBe(false);
    expect(agentTakesMirroredHelpers(undefined, 'a')).toBe(false);
  });

  it('a backup browse also needs the read path to take the login (snapshotReadMirror)', () => {
    const caps: Record<string, string[]> = { old: ['helperImageMirror', 'snapshotLs'], new: ['helperImageMirror', 'snapshotLs', 'snapshotReadMirror'] };
    const hub = { agentBuildFor: (id: string) => ({ version: '1', capabilities: caps[id] ?? [] }) };
    expect(agentTakesMirroredHelpers(hub as never, 'old', 'backup.run')).toBe(true);
    expect(agentTakesMirroredHelpers(hub as never, 'old', 'backup.ls')).toBe(false);
    expect(agentTakesMirroredHelpers(hub as never, 'new', 'backup.ls')).toBe(true);
  });
});
