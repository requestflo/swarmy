import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlatformManifest } from '@swarmy/core/platform-manifest';
import { appendBundleChunk, beginBundleUpload, bundleUploadStatus, finishBundleUpload } from './platform-bundle.service';
import { bundleImages, mirrorPathOf, type LoadBundleDeps } from './platform-bundle.load';
import { importRelease } from './platform-release.service';
import { fakeRegistry, layoutEntries, ociImage, tarOf } from './platform-bundle.test-data';

const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const busybox = ociImage('busybox');
const dns = ociImage('dns');
const manifest = buildPlatformManifest({
  version: '9.1.0',
  channel: 'stable',
  commit: 'c0ffee',
  tag: '9.1.0',
  bom: [
    { key: 'busybox', ref: 'busybox:1.36', digest: busybox.index },
    { key: 'dns', ref: 'ghcr.io/requestflo/swarmy-dns:latest' },
  ],
  digests: { dns: dns.index },
});
const raw = `${JSON.stringify(manifest, null, 2)}\n`;

function bundle(key = kp.privateKey): Uint8Array {
  const sig = sign('sha256', Buffer.from(raw), key).toString('base64');
  return tarOf([['swarmy-bundle/platform.json', raw], ['swarmy-bundle/platform.json.sig', sig], ...layoutEntries([busybox, dns])]);
}

function harness(userId = 'u1') {
  const config: any = { id: 'pc1', orgId: 'org_1', channel: 'stable', currentManifest: null, available: null };
  const audits: string[] = [];
  const dispatched: Array<{ cmd: string; payload: any }> = [];
  const ctx: any = {
    activeOrgId: 'org_1',
    user: { id: userId },
    hub: {
      managerNode: () => 'n1',
      liveInventory: () => ({
        services: [{ id: 'reg', name: 'swarmy-registry', labels: {} }],
        containers: [{ state: 'running', serviceId: 'reg', labels: { 'com.docker.swarm.node.id': 'swn1' } }],
      }),
      dispatch: async (_n: string, cmd: string, payload: unknown) => dispatched.push({ cmd, payload }),
    },
    db: {
      platformConfig: {
        upsert: async () => config,
        update: async ({ data }: any) => Object.assign(config, JSON.parse(JSON.stringify(data))),
      },
      auditLog: { create: async ({ data }: any) => audits.push(data.action) },
    },
  };
  const reg = fakeRegistry();
  const deps: LoadBundleDeps = { fetch: reg.fetchFn, registry: async () => ({ base: 'http://10.0.0.5:5000', authorization: null }), importRelease };
  return { ctx, config, audits, dispatched, reg, deps };
}

async function upload(h: ReturnType<typeof harness>, tar: Uint8Array) {
  const u = await beginBundleUpload(h.ctx, { name: 'swarmy-9.1.0.tar', size: tar.length });
  const b64 = (a: number, b: number) => Buffer.from(tar.subarray(a, b)).toString('base64');
  await appendBundleChunk(h.ctx, { id: u.id, offset: 0, data: b64(0, 1024) });
  await appendBundleChunk(h.ctx, { id: u.id, offset: 0, data: b64(0, 1024) }); // a retried chunk: no-op
  await appendBundleChunk(h.ctx, { id: u.id, offset: 1024, data: b64(1024, tar.length) });
  await finishBundleUpload(h.ctx, { id: u.id }, h.deps, { wait: true });
  return bundleUploadStatus(h.ctx, { id: u.id });
}

let dir = '';
const saved = { key: process.env.SWARMY_RELEASE_PUBKEY, dir: process.env.SWARMY_BUNDLE_DIR };
const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
beforeAll(() => {
  process.env.SWARMY_RELEASE_PUBKEY = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  dir = mkdtempSync(join(tmpdir(), 'swarmy-bundle-test-'));
  process.env.SWARMY_BUNDLE_DIR = dir;
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  restore('SWARMY_RELEASE_PUBKEY', saved.key);
  restore('SWARMY_BUNDLE_DIR', saved.dir);
});

describe('offline bundle upload → verify → registry → mirror labels → release offered', () => {
  it('loads every image at the mirror paths, stamps the mirror labels and stores the release', async () => {
    const h = harness();
    const s = await upload(h, bundle());
    expect(s).toMatchObject({ phase: 'done', version: '9.1.0', total: 2, done: 2, error: null });
    expect(h.reg.manifests.get('swarmy-system/docker.io/library/busybox:1.36')).toBe(busybox.index);
    expect(h.reg.manifests.get('swarmy-system/ghcr.io/requestflo/swarmy-dns:latest')).toBe(dns.index);
    const labels = h.dispatched.find((d) => d.cmd === 'service.updateLabels')!.payload;
    expect(labels.service).toBe('swarmy-registry');
    expect(labels.add).toEqual({
      'swarmy.mirror.busybox': `busybox:1.36@${busybox.index}`,
      'swarmy.mirror.dns': `ghcr.io/requestflo/swarmy-dns:latest@${dns.index}`,
      'swarmy.mirror.node': 'swn1',
    });
    expect(h.config.available).toMatchObject({ verified: true, source: 'bundle', raw });
    expect(h.audits).toEqual(['platform.release.import', 'platform.bundle.load']);
    // Only the release's import labels; adopt (a regctl one-shot) is not re-run.
    expect(h.dispatched.map((d) => d.cmd)).toEqual(['service.updateLabels']);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a bundle signed with another key loads nothing and stores nothing', async () => {
    const h = harness();
    const s = await upload(h, bundle(other.privateKey));
    expect(s.phase).toBe('failed');
    expect(s.error).toMatch(/unverified release: the signature does not match/);
    expect(h.reg.log).toEqual([]);
    expect(h.dispatched).toEqual([]);
    expect(h.config.available).toBeNull();
    expect(h.audits).toEqual(['platform.bundle.load']);
  });

  it('a chunk out of order is refused; only the person who began the upload can add to it', async () => {
    const h = harness();
    const u = await beginBundleUpload(h.ctx, { name: 'b.tar', size: 4096 });
    await expect(appendBundleChunk(h.ctx, { id: u.id, offset: 512, data: 'AAAA' })).rejects.toThrow(/expected the chunk at byte 0/);
    await expect(appendBundleChunk(harness('u2').ctx, { id: u.id, offset: 0, data: 'AAAA' })).rejects.toThrow(/not found/i);
    await expect(finishBundleUpload(h.ctx, { id: u.id }, h.deps)).rejects.toThrow(/only 0 of 4096 bytes/);
    // A new upload replaces the unfinished one (and its file).
    await beginBundleUpload(h.ctx, { name: 'c.tar', size: 4096 });
    expect(() => bundleUploadStatus(h.ctx, { id: u.id })).toThrow(/not found/i);
    expect(existsSync(join(dir, `${u.id}.tar`))).toBe(false);
  });
});

describe('bundleImages / mirrorPathOf', () => {
  it('labels the release’s refs, including components this controller’s BOM does not know', () => {
    const m = { ...manifest, components: { ...manifest.components, future: { ref: 'ghcr.io/x/future:1', image: 'ghcr.io/x/future', digest: dns.index } } };
    const imgs = bundleImages(m);
    expect(imgs.find((i) => i.key === 'busybox')?.digest).toBe(busybox.index);
    expect(imgs.find((i) => (i.key as string) === 'future')).toEqual({ key: 'future' as never, ref: 'ghcr.io/x/future:1', digest: dns.index });
    expect(mirrorPathOf('busybox:1.36')).toEqual({ repo: 'swarmy-system/docker.io/library/busybox', tag: '1.36' });
    expect(mirrorPathOf('ghcr.io/requestflo/swarmy-dns')).toEqual({ repo: 'swarmy-system/ghcr.io/requestflo/swarmy-dns', tag: 'latest' });
  });
});
