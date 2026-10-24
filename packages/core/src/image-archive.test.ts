import { describe, expect, it } from 'bun:test';
import {
  archiveFileName,
  archiveFiles,
  archiveTarget,
  nodeArchivePlatform,
  pickPlatformManifest,
  sha256Of,
  verifyImageArchive,
  type ArchivePlatform,
} from './image-archive';
import { indexTarStrict, writeTar } from './tar';

const enc = new TextEncoder();
const NAME = 'ghcr.io/netbirdio/netbird:0.79.0';

/** A two-platform image: index → per-arch manifest → config + one layer. */
function image() {
  const layer = enc.encode('layer-bytes-amd64');
  const config = enc.encode('{"architecture":"amd64","rootfs":{"type":"layers","diff_ids":[]}}');
  const manifest = enc.encode(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { digest: sha256Of(config), size: config.length },
    layers: [{ digest: sha256Of(layer), size: layer.length }],
  }));
  const desc = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: sha256Of(manifest), size: manifest.length, platform: { os: 'linux', architecture: 'amd64' } };
  const index = enc.encode(JSON.stringify({
    schemaVersion: 2,
    manifests: [
      desc,
      { digest: `sha256:${'1'.repeat(64)}`, platform: { os: 'linux', architecture: 'arm64' } },
      { digest: `sha256:${'2'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } },
    ],
  }));
  const files = archiveFiles({ name: NAME, index, manifest, manifestDesc: desc, blobs: new Map([[sha256Of(config), config], [sha256Of(layer), layer]]) });
  return { files, indexDigest: sha256Of(index), manifestDigest: desc.digest, configDigest: sha256Of(config), layer };
}

const reader = (tar: Uint8Array) => async (o: number, n: number) => tar.subarray(o, o + n);
const check = (tar: Uint8Array, indexDigest: string, platform: ArchivePlatform = 'linux/amd64') =>
  verifyImageArchive(reader(tar), tar.length, { indexDigest, platform, name: NAME });

describe('node image archives (a new node loads the NetBird client from the controller)', () => {
  it('names files by digest + platform and maps refs/arches', () => {
    expect(archiveFileName(`sha256:${'a'.repeat(64)}`, 'linux/arm64')).toBe(`sha256-${'a'.repeat(64)}-linux-arm64.tar`);
    expect(nodeArchivePlatform('x64')).toBe('linux/amd64');
    expect(nodeArchivePlatform('arm64')).toBe('linux/arm64');
    expect(nodeArchivePlatform('ia32')).toBeNull();
    expect(archiveTarget(`caddy:2-alpine@sha256:${'b'.repeat(64)}`)).toEqual({ name: 'docker.io/library/caddy:2-alpine', indexDigest: `sha256:${'b'.repeat(64)}` });
    expect(archiveTarget('caddy:2-alpine')).toBeNull();
    expect(pickPlatformManifest({ manifests: [] }, 'linux/amd64')).toBeNull();
  });

  it('a built archive verifies against the pinned index digest; the ids are what docker load yields', async () => {
    const img = image();
    const tar = writeTar(img.files);
    expect([...(await indexTarStrict(reader(tar), tar.length)).keys()]).toEqual(img.files.map(([n]) => n));
    expect(await check(tar, img.indexDigest)).toEqual({ ok: true, ids: [img.configDigest, img.manifestDigest] });
  });

  it('refuses another image, another platform, a tampered blob, an extra file, a re-pointed manifest.json', async () => {
    const img = image();
    expect(await check(writeTar(img.files), `sha256:${'f'.repeat(64)}`)).toMatchObject({ ok: false });
    expect(await check(writeTar(img.files), img.indexDigest, 'linux/arm64')).toMatchObject({ ok: false });
    const swap = (name: string, body: Uint8Array) => writeTar(img.files.map(([n, b]) => [n, n === name ? body : b] as [string, Uint8Array]));
    expect(await check(swap(`blobs/sha256/${sha256Of(img.layer).slice(7)}`, enc.encode('evil')), img.indexDigest)).toMatchObject({ ok: false, reason: expect.stringContaining('does not match') });
    expect(await check(writeTar([...img.files, ['run.sh', enc.encode('x')]]), img.indexDigest)).toMatchObject({ ok: false, reason: 'unexpected file run.sh' });
    const evil = enc.encode('evil-config');
    const repointed = [...img.files, [`blobs/sha256/${sha256Of(evil).slice(7)}`, evil] as [string, Uint8Array]].map(([n, b]) =>
      [n, n === 'manifest.json' ? enc.encode(JSON.stringify([{ Config: `blobs/sha256/${sha256Of(evil).slice(7)}`, RepoTags: [NAME], Layers: [] }])) : b] as [string, Uint8Array]);
    expect(await check(writeTar(repointed), img.indexDigest)).toMatchObject({ ok: false, reason: 'manifest.json does not name the verified image' });
    const renamed = img.files.map(([n, b]) => [n, n === 'index.json' ? enc.encode(new TextDecoder().decode(b).replace(NAME, 'ghcr.io/requestflo/swarmy-agent:latest')) : b] as [string, Uint8Array]);
    expect(await check(writeTar(renamed), img.indexDigest)).toMatchObject({ ok: false, reason: 'index.json does not name the verified image' });
  });

  it('refuses links and duplicate names (docker load would read something else)', async () => {
    const img = image();
    const tar = writeTar(img.files);
    const link = tar.slice();
    link[156] = '2'.charCodeAt(0); // first member becomes a symlink (checksum aside, the type is what matters)
    expect(await check(link, img.indexDigest)).toMatchObject({ ok: false, reason: expect.stringContaining('link') });
    expect(await check(writeTar([...img.files, img.files[3]!]), img.indexDigest)).toMatchObject({ ok: false, reason: expect.stringContaining('twice') });
  });
});
