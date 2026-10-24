import { afterAll, describe, expect, it } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import { buildPlatformManifest, canonicalManifestJson } from '@swarmy/core/platform-manifest';
import { MIRROR_OK_MARKER, SYSTEM_IMAGES } from '@swarmy/core/system-images';
import { BUNDLE_MANIFEST_MARKER, BUNDLE_NONE_MARKER, BUNDLE_SIG_MARKER, MIRROR_BUNDLE_LABEL } from '@swarmy/core/system-images-bundle';
import type { AgentHub } from '../hub/types';
import { bundleVolume, seedRegistryFromBundle } from './system-images-bundle.service';
import { seedKv } from './swarm-kv.service';

const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const prevKey = process.env.SWARMY_RELEASE_PUBKEY;
process.env.SWARMY_RELEASE_PUBKEY = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
afterAll(() => {
  if (prevKey === undefined) delete process.env.SWARMY_RELEASE_PUBKEY;
  else process.env.SWARMY_RELEASE_PUBKEY = prevKey;
});

const d = (c: string) => `sha256:${c.repeat(64)}`;
const FLOATING = SYSTEM_IMAGES.filter((i) => !i.digest).map((i) => i.key);
const manifest = buildPlatformManifest({ version: '1.3.0', channel: 'stable', commit: 'c', tag: '1.3.0', digests: Object.fromEntries(FLOATING.map((k) => [k, d('a')])) });
const RAW = canonicalManifestJson(manifest);
const SIG = sign('sha256', Buffer.from(RAW), kp.privateKey).toString('base64');
const b64 = (s: string) => Buffer.from(s).toString('base64');

type Call = { node: string; cmd: string; p: Record<string, any> };

/** The registry runs on swarmn1 (node m1); the copy one-shot answers OK for every image unless `fail`. */
function fakes(opts: { labels?: Record<string, string>; read?: string; fail?: string[] } = {}) {
  const calls: Call[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const registry = { id: 'svc-reg', name: 'swarmy-registry', image: 'registry:2', labels: { 'swarmy.mirror.node': 'swarmn1', ...opts.labels } };
  const task = { id: 'c', serviceId: 'svc-reg', state: 'running', labels: { 'com.docker.swarm.node.id': 'swarmn1' } };
  const hub = {
    liveInventory: () => ({ services: [registry], containers: [task] }),
    managerNode: () => 'm2',
    managerNodes: () => ['m2', 'm1'],
    nodeInfoFor: (id: string) => ({ hostname: id === 'm1' ? 'node-1' : 'node-2' }),
    dispatch: async (node: string, cmd: string, p: Record<string, any>) => {
      calls.push({ node, cmd, p });
      if (cmd !== 'container.runOnce') return {};
      const script = String(p.cmd[0]);
      if (script.includes('base64')) return { exitCode: 0, output: opts.read ?? `${BUNDLE_MANIFEST_MARKER} ${b64(RAW)}\n${BUNDLE_SIG_MARKER} ${b64(SIG)}\n` };
      const ok = [...script.matchAll(/ocidir:\/\/[^@]+@(sha256:[a-f0-9]{64})'[^\n]*echo "@@SWARMY-MIRROR-OK@@ (\w+)/g)]
        .filter((m) => !opts.fail?.includes(m[2]!))
        .map((m) => `${MIRROR_OK_MARKER} ${m[2]} ${m[1]}`);
      return { exitCode: 0, output: ok.join('\n') };
    },
  } as unknown as AgentHub;
  let config: any = { orgId: 'o1', available: null, currentManifest: null };
  const db = {
    auditLog: { create: async (a: { data: Record<string, unknown> }) => void audits.push(a.data) },
    platformConfig: { upsert: async () => config, update: async ({ data }: any) => (config = { ...config, ...data }) },
  } as unknown as DB;
  seedKv(hub, 'o1', 'registry', 'o1', { enabled: true, host: 'localhost:5000', credentialsEnc: null });
  return { deps: { db, hub, auth: {} as Auth }, calls, audits, config: () => config };
}

describe('seedRegistryFromBundle (install-swarmy.sh --bundle → built-in registry, like the bundle upload)', () => {
  it('verifies, copies every signed image by digest on the installer node, labels, offers the release, frees the volume', async () => {
    process.env.SWARMY_BUNDLE_HOSTNAME = 'node-1';
    const f = fakes();
    const r = await seedRegistryFromBundle(f.deps, 'o1', 'swarmy-bundle');
    expect(r.state).toBe('seeded');
    const oneShots = f.calls.filter((c) => c.cmd === 'container.runOnce');
    expect(oneShots).toHaveLength(2);
    for (const c of oneShots) {
      expect(c.node).toBe('m1');
      expect(c.p.binds).toEqual(['swarmy-bundle:/bundle:ro']);
    }
    expect(oneShots[1]!.p.networks).toEqual(['host']);
    const labels = f.calls.find((c) => c.cmd === 'service.updateLabels')!.p;
    expect(labels.service).toBe('swarmy-registry');
    expect(labels.add[MIRROR_BUNDLE_LABEL]).toBe('1.3.0');
    expect(labels.add['swarmy.mirror.caddy']).toBe(`caddy:2-alpine@${SYSTEM_IMAGES.find((i) => i.key === 'caddy')!.digest}`);
    expect(labels.add['swarmy.mirror.controller']).toBe(`ghcr.io/requestflo/swarmy-controller:latest@${d('a')}`);
    expect(f.calls.find((c) => c.cmd === 'volume.remove')?.p).toEqual({ name: 'swarmy-bundle', cluster: false });
    expect(f.config().available.version ?? f.config().available.manifest.version).toBe('1.3.0');
    expect(f.audits.some((a) => a.action === 'platform.bundle.load' && a.actorType === 'system')).toBe(true);
    delete process.env.SWARMY_BUNDLE_HOSTNAME;
  });

  it('copies nothing for a bundle whose signature fails', async () => {
    const f = fakes({ read: `${BUNDLE_MANIFEST_MARKER} ${b64(RAW.replace('"commit":"c"', '"commit":"x"'))}\n${BUNDLE_SIG_MARKER} ${b64(SIG)}\n` });
    expect((await seedRegistryFromBundle(f.deps, 'o1', 'swarmy-bundle')).state).toBe('unverified');
    expect(f.calls.map((c) => c.cmd)).toEqual(['container.runOnce']);
  });

  it('a failed copy keeps the volume and leaves the bundle label off (the worker retries)', async () => {
    const f = fakes({ fail: ['netbirdClient'] });
    const r = await seedRegistryFromBundle(f.deps, 'o1', 'swarmy-bundle');
    expect(r).toMatchObject({ state: 'partial', failed: ['netbirdClient'] });
    const labels = f.calls.find((c) => c.cmd === 'service.updateLabels')!.p;
    expect(labels.add[MIRROR_BUNDLE_LABEL]).toBeUndefined();
    expect(labels.add['swarmy.mirror.caddy']).toBeDefined();
    expect(f.calls.some((c) => c.cmd === 'volume.remove')).toBe(false);
  });

  it('waits for the registry, stops once seeded, and says when the volume holds no bundle', async () => {
    expect((await seedRegistryFromBundle(fakes({ labels: { [MIRROR_BUNDLE_LABEL]: '1.3.0' } }).deps, 'o1', 'v')).state).toBe('skipped');
    const none = fakes({ read: `${BUNDLE_NONE_MARKER}\n` });
    expect((await seedRegistryFromBundle(none.deps, 'o1', 'v')).state).toBe('none');
    expect(none.calls).toHaveLength(1);
    expect(bundleVolume({ SWARMY_BUNDLE_VOLUME: 'swarmy-bundle' })).toBe('swarmy-bundle');
    expect(bundleVolume({ SWARMY_BUNDLE_VOLUME: '/etc:/x' })).toBeNull();
    expect(bundleVolume({})).toBeNull();
  });
});
