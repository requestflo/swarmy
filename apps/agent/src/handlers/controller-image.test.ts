import { describe, expect, test } from 'bun:test';
import { archiveFiles, sha256Of } from '@swarmy/core/image-archive';
import { writeTar } from '@swarmy/core/tar';
import { loadImageFromController, type ControllerImageDocker } from './controller-image';
import { resolveMeshClientImage } from './mesh-image';

const enc = new TextEncoder();
const NAME = 'ghcr.io/netbirdio/netbird:0.79.0';

/** A real one-platform archive (linux/amd64) of a tiny image, and the ref that pins it. */
function archive() {
  const layer = enc.encode('netbird-layer');
  const config = enc.encode('{"architecture":"amd64"}');
  const manifest = enc.encode(JSON.stringify({ schemaVersion: 2, config: { digest: sha256Of(config) }, layers: [{ digest: sha256Of(layer) }] }));
  const desc = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: sha256Of(manifest), platform: { os: 'linux', architecture: 'amd64' } };
  const index = enc.encode(JSON.stringify({ schemaVersion: 2, manifests: [desc] }));
  const tar = writeTar(archiveFiles({ name: NAME, index, manifest, manifestDesc: desc, blobs: new Map([[sha256Of(config), config], [sha256Of(layer), layer]]) }));
  return { tar, ref: `${NAME}@${sha256Of(index)}`, configId: sha256Of(config), manifestId: desc.digest };
}

function fakes(opts: { body?: Uint8Array | null; loadedId?: string; loadError?: string } = {}) {
  const urls: string[] = [];
  let loaded = 0;
  const docker: ControllerImageDocker = {
    docker: {
      loadImage: async (s) => {
        for await (const _ of s as AsyncIterable<unknown>) void _; // drain the file, like dockerd
        loaded++;
        return s;
      },
      modem: { followProgress: (_s, done) => done(null, opts.loadError ? [{ error: opts.loadError }] : [{}]) },
      getImage: (ref) => ({ inspect: async () => (ref === NAME && loaded ? { Id: opts.loadedId } : Promise.reject(new Error('no such image'))) }),
    },
  };
  const fetchFn = (async (url: string) => {
    urls.push(url);
    return opts.body ? new Response(opts.body) : new Response('no', { status: 404 });
  }) as unknown as typeof fetch;
  return { docker, urls, loads: () => loaded, opts: { base: 'https://ctl.example/', fetchFn, arch: 'x64' } };
}

describe('loadImageFromController (a new node joins without GHCR)', () => {
  test('fetches the archive named by the pinned digest, verifies it, loads it, runs it by id', async () => {
    const a = archive();
    for (const id of [a.configId, a.manifestId]) { // classic store, containerd store
      const f = fakes({ body: a.tar, loadedId: id });
      expect(await loadImageFromController(f.docker, a.ref, f.opts)).toBe(id);
      expect(f.urls).toEqual([`https://ctl.example/install/images/${a.ref.split('@')[1]!.replace(':', '-')}-linux-amd64.tar`]);
    }
  });

  test('null (so the caller pulls upstream) when the controller lacks it, it fails to verify, or another image loaded', async () => {
    const a = archive();
    expect(await loadImageFromController(fakes().docker, a.ref, fakes().opts)).toBeNull();
    const tampered = a.tar.slice();
    const at = Buffer.from(tampered).indexOf('netbird-layer');
    tampered[at] = tampered[at]! ^ 1; // one bit of the layer
    const bad = fakes({ body: tampered, loadedId: a.configId });
    expect(await loadImageFromController(bad.docker, a.ref, bad.opts)).toBeNull();
    expect(bad.loads()).toBe(0); // never handed to docker
    const other = fakes({ body: a.tar, loadedId: `sha256:${'e'.repeat(64)}` });
    expect(await loadImageFromController(other.docker, a.ref, other.opts)).toBeNull();
    const failed = fakes({ body: a.tar, loadedId: a.configId, loadError: 'no space left' });
    expect(await loadImageFromController(failed.docker, a.ref, failed.opts)).toBeNull();
  });

  test('only digest-pinned refs, only built platforms: no request otherwise', async () => {
    const f = fakes({ body: archive().tar });
    expect(await loadImageFromController(f.docker, `${NAME}`, f.opts)).toBeNull();
    expect(await loadImageFromController(f.docker, archive().ref, { ...f.opts, arch: 'riscv64' })).toBeNull();
    expect(f.urls).toEqual([]);
  });
});

describe('resolveMeshClientImage with the controller loader (first mesh join)', () => {
  const UP = archive().ref;
  const docker = (present: boolean, pulls: string[]) => ({
    pullImage: async (r: string) => void pulls.push(r) as unknown as string,
    docker: { getImage: () => ({ inspect: async () => (present ? {} : Promise.reject(new Error('none'))) }) },
  });

  test('on the node already: no network; else the controller copy by id; else upstream', async () => {
    const pulls: string[] = [];
    const asked: string[] = [];
    const load = async (r: string) => (asked.push(r), 'sha256:loaded');
    expect(await resolveMeshClientImage(docker(true, pulls), UP, undefined, load)).toBe(UP);
    expect(asked).toEqual([]);
    expect(await resolveMeshClientImage(docker(false, pulls), UP, undefined, load)).toBe('sha256:loaded');
    expect(pulls).toEqual([]);
    expect(await resolveMeshClientImage(docker(false, pulls), UP, undefined, async () => null)).toBe(UP);
    expect(pulls).toEqual([UP]);
  });
});
