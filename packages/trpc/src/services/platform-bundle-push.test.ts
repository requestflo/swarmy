import { describe, expect, it } from 'bun:test';
import { RegistryPusher, uploadUrl } from './platform-bundle-push';
import { bytes, digestOf, fakeRegistry, ociImage } from './platform-bundle.test-data';

const BASE = 'http://10.0.0.5:5000';
const AUTH = `Basic ${btoa('swarmy:pw')}`;
const REPO = 'swarmy-system/docker.io/library/busybox';

function layoutOf(...images: Array<ReturnType<typeof ociImage>>) {
  const all = new Map<string, Uint8Array>();
  for (const i of images) for (const [d, b] of i.blobs) all.set(d, b);
  return (d: string) => (all.has(d) ? new Blob([all.get(d)!]) : null);
}

describe('RegistryPusher: an OCI layout into the built-in registry, digest-preserving', () => {
  it('pushes blobs, then the child manifest by digest, then the index under its tag', async () => {
    const img = ociImage('a');
    const reg = fakeRegistry(AUTH);
    await new RegistryPusher({ base: BASE, authorization: AUTH }, layoutOf(img), reg.fetchFn).pushImage(REPO, '1.36', img.index);
    expect(reg.manifests.get(`${REPO}:1.36`)).toBe(img.index);
    expect(reg.blobs.get(REPO)?.size).toBe(2);
    const puts = reg.log.filter((l) => l.startsWith('PUT'));
    expect(puts.at(-1)).toBe(`PUT 10.0.0.5:5000/v2/${REPO}/manifests/1.36`);
    expect(puts.filter((l) => l.includes('/manifests/sha256:')).length).toBe(1);
    // The registry's upload Location named a host we can't reach: we stay on our base.
    expect(puts.filter((l) => l.includes('/blobs/uploads/')).every((l) => l.startsWith('PUT 10.0.0.5:5000/'))).toBe(true);
  });

  it('skips blobs the registry already has, and mounts across repos instead of re-uploading', async () => {
    const img = ociImage('b');
    const reg = fakeRegistry();
    const p = new RegistryPusher({ base: BASE, authorization: null }, layoutOf(img), reg.fetchFn);
    await p.pushImage(REPO, '1.36', img.index);
    const before = reg.log.filter((l) => l.startsWith('PUT') && l.includes('/blobs/uploads/')).length;
    await p.pushImage(REPO, '1.36', img.index);
    await p.pushImage('swarmy-system/docker.io/library/other', 'v1', img.index);
    const uploads = reg.log.filter((l) => l.startsWith('PUT') && l.includes('/blobs/uploads/')).length;
    expect(uploads).toBe(before);
    expect(reg.log.some((l) => l.includes('?mount=sha256'))).toBe(true);
    expect(reg.manifests.get('swarmy-system/docker.io/library/other:v1')).toBe(img.index);
  });

  it('refuses a manifest whose bytes do not match its digest — nothing is tagged', async () => {
    const img = ociImage('c');
    const forged = new Map(img.blobs);
    forged.set(img.index, bytes('{"schemaVersion":2,"manifests":[]}'));
    const reg = fakeRegistry();
    const p = new RegistryPusher({ base: BASE, authorization: null }, (d) => (forged.has(d) ? new Blob([forged.get(d)!]) : null), reg.fetchFn);
    await expect(p.pushImage(REPO, '1.36', img.index)).rejects.toThrow(/does not match its digest/);
    expect(reg.manifests.size).toBe(0);
  });

  it('says which blob a bundle is missing', async () => {
    const img = ociImage('d');
    const partial = new Map(img.blobs);
    const layer = [...partial.keys()].find((d) => new TextDecoder().decode(partial.get(d)).startsWith('layer-'))!;
    partial.delete(layer);
    const reg = fakeRegistry();
    const p = new RegistryPusher({ base: BASE, authorization: null }, (d) => (partial.has(d) ? new Blob([partial.get(d)!]) : null), reg.fetchFn);
    await expect(p.pushImage(REPO, '1.36', img.index)).rejects.toThrow(`missing blob ${layer}`);
  });

  it('a registry error surfaces with its status', async () => {
    const img = ociImage('e');
    const reg = fakeRegistry(AUTH);
    const p = new RegistryPusher({ base: BASE, authorization: `Basic ${btoa('wrong:pw')}` }, layoutOf(img), reg.fetchFn);
    await expect(p.pushImage(REPO, '1.36', img.index)).rejects.toThrow(/HTTP 401/);
  });
});

describe('uploadUrl', () => {
  it('keeps the path + state, moves the origin to our base, adds the digest', () => {
    const d = digestOf(bytes('x'));
    expect(uploadUrl(BASE, 'http://localhost:5000/v2/r/blobs/uploads/u1?_state=s', d)).toBe(
      `${BASE}/v2/r/blobs/uploads/u1?_state=s&digest=${encodeURIComponent(d)}`,
    );
    expect(uploadUrl(BASE, '/v2/r/blobs/uploads/u2', d)).toBe(`${BASE}/v2/r/blobs/uploads/u2?digest=${encodeURIComponent(d)}`);
  });
});
