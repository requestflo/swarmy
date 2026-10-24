#!/usr/bin/env bun
/**
 * Build time: fetch the images a NEW node needs before it can reach the
 * cluster's registry (`NODE_BOOTSTRAP_IMAGE_KEYS`: the NetBird client for the
 * first mesh join, the registry forwarder's Caddy) as per-architecture
 * `docker load` archives, byte-for-byte at the BOM pins
 * (packages/core/src/image-archive.ts). The controller serves them at
 * /install/images/<file> (apps/api Dockerfile stage `nodeimages`;
 * SWARMY_BUNDLE_NODE_IMAGES=0 opts out).
 *
 *   bun scripts/fetch-node-images.ts <out-dir>
 *
 * Every manifest and blob is checked against its digest as it arrives, and
 * each archive is verified the way the agent will before it is written.
 * Best-effort, like the NetBird desktop clients: an image that can't be
 * fetched is skipped, and a node then pulls it upstream as before.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARCHIVE_PLATFORMS,
  NODE_BOOTSTRAP_IMAGE_KEYS,
  archiveFileName,
  archiveFiles,
  archiveTarget,
  pickPlatformManifest,
  sha256Of,
  verifyImageArchive,
} from '../packages/core/src/image-archive';
import { writeTar } from '../packages/core/src/tar';
import { parseImageRef, pinnedTaggedRef } from '../packages/core/src/system-images';

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const tokens = new Map<string, string>();

/** Anonymous pull token for `repo` from the registry's Bearer challenge. */
async function token(challenge: string, repo: string): Promise<string> {
  const kv = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
  if (!kv.realm) throw new Error(`no token realm in ${challenge}`);
  const u = new URL(kv.realm);
  if (kv.service) u.searchParams.set('service', kv.service);
  u.searchParams.set('scope', kv.scope ?? `repository:${repo}:pull`);
  const res = await fetch(u, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`token: HTTP ${res.status}`);
  const body = (await res.json()) as { token?: string; access_token?: string };
  return body.token ?? body.access_token ?? '';
}

/** GET `/v2/<repo>/<kind>/<digest>` and check the bytes hash to `digest`. Blob redirects drop the auth header. */
async function fetchDigest(host: string, repo: string, kind: 'manifests' | 'blobs', digest: string): Promise<Uint8Array> {
  const url = `https://${host === 'docker.io' ? 'registry-1.docker.io' : host}/v2/${repo}/${kind}/${digest}`;
  const call = (auth: boolean) =>
    fetch(url, {
      headers: { accept: ACCEPT, ...(auth && tokens.get(repo) ? { authorization: `Bearer ${tokens.get(repo)}` } : {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(300_000),
    });
  let res = await call(true);
  if (res.status === 401) {
    tokens.set(repo, await token(res.headers.get('www-authenticate') ?? '', repo));
    res = await call(true);
  }
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    res = await fetch(new URL(res.headers.get('location')!, url), { signal: AbortSignal.timeout(300_000) });
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (sha256Of(bytes) !== digest) throw new Error(`${url} does not match its digest`);
  return bytes;
}

const out = process.argv[2] ?? 'node-images';
mkdirSync(out, { recursive: true });
const json = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));
for (const key of NODE_BOOTSTRAP_IMAGE_KEYS) {
  const ref = pinnedTaggedRef(key);
  const target = archiveTarget(ref);
  if (!target) {
    console.log(`${key}: ${ref} is not digest-pinned, skipped`);
    continue;
  }
  const p = parseImageRef(ref);
  try {
    const index = await fetchDigest(p.host, p.path, 'manifests', target.indexDigest);
    for (const platform of ARCHIVE_PLATFORMS) {
      const desc = pickPlatformManifest(json(index), platform);
      if (!desc) {
        console.log(`${key}: no ${platform} build`);
        continue;
      }
      const manifest = await fetchDigest(p.host, p.path, 'manifests', desc.digest);
      const m = json(manifest) as { config: { digest: string }; layers: Array<{ digest: string }> };
      const blobs = new Map<string, Uint8Array>();
      for (const d of [m.config, ...m.layers]) blobs.set(d.digest, await fetchDigest(p.host, p.path, 'blobs', d.digest));
      const tar = writeTar(archiveFiles({ name: target.name, index, manifest, manifestDesc: desc, blobs }));
      const check = await verifyImageArchive(async (o, n) => tar.subarray(o, o + n), tar.length, { ...target, platform });
      if (!check.ok) throw new Error(`the ${platform} archive does not verify: ${check.reason}`);
      const file = archiveFileName(target.indexDigest, platform);
      writeFileSync(join(out, file), tar);
      console.log(`${key} ${platform}: ${file} (${(tar.length / 1e6).toFixed(1)} MB)`);
    }
  } catch (e) {
    console.log(`${key}: skipped (${e instanceof Error ? e.message : String(e)}); nodes pull it upstream`);
  }
}
