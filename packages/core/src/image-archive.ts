/**
 * Per-architecture image archives a NEW node loads with `docker load` before it
 * can reach the cluster's registry: the NetBird client for its first mesh join
 * (the swarm, and so the registry forwarder, only come after the mesh) and the
 * forwarder's Caddy. The controller serves them at `/install/images/<file>`,
 * built into its image (`scripts/fetch-node-images.ts`), so a node needs neither
 * GHCR nor Docker Hub to join.
 *
 * Format — what `docker save` writes since Docker 25, so both image stores load it:
 * `oci-layout`; `index.json` → the platform manifest, named `<repo>:<tag>`
 * (containerd store); `manifest.json` with Config + Layers (classic store); and
 * `blobs/sha256/<hex>` for the pinned multi-arch INDEX, the platform manifest,
 * its config and its layers.
 *
 * Trust: the controller is only transport. The agent checks the archive against
 * the digest in the ref it was about to run anyway (its BOM pin, `ref@sha256:…`):
 * the index blob hashes to it and lists this platform's manifest; every blob
 * hashes to its name; index.json and manifest.json point at exactly those
 * blobs; nothing else is in the archive (`indexTarStrict` refuses links).
 * Pure; tested in image-archive.test.ts.
 */
import { createHash } from 'node:crypto';
import { indexTarStrict, type TarReadAt } from './tar';
import { parseImageRef } from './system-images';

/** BOM keys a node needs before it can pull from the cluster. */
export const NODE_BOOTSTRAP_IMAGE_KEYS = ['netbirdClient', 'caddy'] as const;
export const ARCHIVE_PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;
export type ArchivePlatform = (typeof ARCHIVE_PLATFORMS)[number];

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const enc = new TextEncoder();

interface Descriptor {
  mediaType?: string;
  digest: string;
  size?: number;
  platform?: { os?: string; architecture?: string; variant?: string };
  annotations?: Record<string, string>;
}

export const sha256Of = (b: Uint8Array): string => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const blobPath = (digest: string) => `blobs/sha256/${digest.slice('sha256:'.length)}`;

/** `sha256-<hex>-linux-<arch>.tar`: what the controller serves for one image + platform. */
export function archiveFileName(indexDigest: string, platform: ArchivePlatform): string {
  if (!DIGEST_RE.test(indexDigest)) throw new Error(`not a digest: ${indexDigest}`);
  return `sha256-${indexDigest.slice(7)}-${platform.replace('/', '-')}.tar`;
}

/** This node's archive platform (`process.arch`), or null when none is built for it. */
export function nodeArchivePlatform(arch: string = process.arch): ArchivePlatform | null {
  return arch === 'x64' || arch === 'amd64' ? 'linux/amd64' : arch === 'arm64' ? 'linux/arm64' : null;
}

/** `<host>/<path>:<tag>`: the name the loaded image gets (and the digest the ref pins), or null. */
export function archiveTarget(ref: string): { name: string; indexDigest: string } | null {
  const p = parseImageRef(ref);
  if (!p.digest || !DIGEST_RE.test(p.digest)) return null;
  return { name: `${p.host}/${p.path}:${p.tag ?? 'latest'}`, indexDigest: p.digest };
}

/** The descriptor of `platform`'s image manifest in a multi-arch index (attestations skipped). */
export function pickPlatformManifest(index: { manifests?: Descriptor[] }, platform: ArchivePlatform): Descriptor | null {
  const [os, architecture] = platform.split('/');
  const hit = (index.manifests ?? []).find(
    (d) => d.platform?.os === os && d.platform?.architecture === architecture && !d.annotations?.['vnd.docker.reference.type'],
  );
  return hit && DIGEST_RE.test(hit.digest) ? hit : null;
}

/** The archive's files, from the verified upstream bytes. `blobs` = config + layers by digest. */
export function archiveFiles(i: { name: string; index: Uint8Array; manifest: Uint8Array; manifestDesc: Descriptor; blobs: Map<string, Uint8Array> }): Array<[string, Uint8Array]> {
  const m = JSON.parse(new TextDecoder().decode(i.manifest)) as { config: Descriptor; layers: Descriptor[] };
  const desc = { mediaType: i.manifestDesc.mediaType, digest: sha256Of(i.manifest), size: i.manifest.length, ...(i.manifestDesc.platform ? { platform: i.manifestDesc.platform } : {}) };
  const tag = i.name.slice(i.name.lastIndexOf(':') + 1);
  const indexJson = { schemaVersion: 2, mediaType: OCI_INDEX, manifests: [{ ...desc, annotations: { 'io.containerd.image.name': i.name, 'org.opencontainers.image.ref.name': tag } }] };
  const dockerJson = [{ Config: blobPath(m.config.digest), RepoTags: [i.name], Layers: m.layers.map((l) => blobPath(l.digest)) }];
  const files: Array<[string, Uint8Array]> = [
    ['oci-layout', enc.encode('{"imageLayoutVersion":"1.0.0"}')],
    ['index.json', enc.encode(JSON.stringify(indexJson))],
    ['manifest.json', enc.encode(JSON.stringify(dockerJson))],
    [blobPath(sha256Of(i.index)), i.index],
    [blobPath(desc.digest), i.manifest],
  ];
  for (const d of [m.config, ...m.layers]) {
    const b = i.blobs.get(d.digest);
    if (!b) throw new Error(`missing blob ${d.digest}`);
    files.push([blobPath(d.digest), b]);
  }
  return files;
}

export type ArchiveCheck = { ok: true; ids: string[] } | { ok: false; reason: string };

/** Verify an archive (see the module comment). `ids`: the image ids a correct load yields. */
export async function verifyImageArchive(
  read: TarReadAt,
  size: number,
  expect: { indexDigest: string; platform: ArchivePlatform; name: string },
): Promise<ArchiveCheck> {
  try {
    const files = await indexTarStrict(read, size);
    const bytes = async (n: string) => {
      const f = files.get(n);
      if (!f) throw new Error(`the archive has no ${n}`);
      return read(f.offset, f.size);
    };
    const json = async <T>(n: string) => JSON.parse(new TextDecoder().decode(await bytes(n))) as T;
    for (const name of files.keys()) {
      if (['oci-layout', 'index.json', 'manifest.json'].includes(name)) continue;
      const m = /^blobs\/sha256\/([a-f0-9]{64})$/.exec(name);
      if (!m) throw new Error(`unexpected file ${name}`);
      if (sha256Of(await bytes(name)) !== `sha256:${m[1]}`) throw new Error(`${name} does not match its digest`);
    }
    const want = pickPlatformManifest(await json<{ manifests?: Descriptor[] }>(blobPath(expect.indexDigest)), expect.platform);
    if (!want) throw new Error(`the pinned image has no ${expect.platform} build`);
    const m = await json<{ config: Descriptor; layers: Descriptor[] }>(blobPath(want.digest));
    const paths = [m.config, ...m.layers].map((d) => blobPath(d.digest));
    for (const p of paths) if (!files.has(p)) throw new Error(`the archive has no ${p}`);
    const docker = await json<Array<{ Config?: string; RepoTags?: string[]; Layers?: string[] }>>('manifest.json');
    if (docker.length !== 1 || docker[0]!.Config !== paths[0] || JSON.stringify(docker[0]!.Layers) !== JSON.stringify(paths.slice(1))) {
      throw new Error('manifest.json does not name the verified image');
    }
    if ((docker[0]!.RepoTags ?? []).some((t) => t !== expect.name)) throw new Error('manifest.json names another image');
    const idx = await json<{ manifests?: Descriptor[] }>('index.json');
    const named = (d: Descriptor) => (d.annotations?.['io.containerd.image.name'] ?? expect.name) === expect.name;
    if (!idx.manifests?.length || idx.manifests.some((d) => d.digest !== want.digest || !named(d))) throw new Error('index.json does not name the verified image');
    return { ok: true, ids: [m.config.digest, want.digest] };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
