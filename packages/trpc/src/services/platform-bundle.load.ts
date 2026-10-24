/**
 * Load an offline platform bundle (plans/epic-platform-upgrades.md §1,
 * "Offline bundles"): `swarmy-<ver>.tar` = platform.json + .sig + every
 * release image as an OCI layout (`scripts/platform-bundle.ts`).
 *
 *   1. verify platform.json against the swarmy release key — nothing is
 *      pushed for a release that fails (offline, node:crypto);
 *   2. push each component into the built-in registry at the SAME
 *      `swarmy-system/<host>/<path>:<tag>` paths the system-image mirror uses;
 *   3. stamp the mirror labels (`swarmy.mirror.<key>=<ref>@<digest>`) on the
 *      registry service, so the run deploys every service from the cluster;
 *   4. store the release as available (`importRelease`, source `bundle`):
 *      Upgrade is then offered exactly as for a feed release.
 */
import type { PlatformManifest } from '@swarmy/core/platform-manifest';
import { manifestImages } from '@swarmy/core/platform-manifest';
import { SYSTEM_MIRROR_NAMESPACE, mirrorLabelsAfter, parseImageRef, type SystemImage, type SystemImageKey } from '@swarmy/core/system-images';
import type { OrgContext } from '../context';
import { registryConfigs } from './apps.repo';
import { registryBaseCandidates } from './images-local';
import { bundleEntry, indexTar, type ReadAt, type TarEntry } from './platform-bundle-tar';
import { RegistryPusher, type FetchFn, type RegistryTarget } from './platform-bundle-push';
import { importRelease, verifyRelease } from './platform-release.service';
import { REGISTRY_SERVICE_NAME, decodeRegistryCreds } from './registry-auth';
import { canonicalRegistryHost } from './registryPolicy.service';
import { mirrorStateFrom } from './system-images.service';

export interface BundleProgress {
  version?: string;
  total?: number;
  done?: number;
  current?: string | null;
}

export interface LoadBundleDeps {
  fetch: FetchFn;
  registry: (ctx: OrgContext, fetchFn: FetchFn) => Promise<RegistryTarget | null>;
  importRelease: typeof importRelease;
}

/** The first registry base that answers `GET /v2/` with the org's login, or null when the registry is off. */
export async function resolveRegistryTarget(ctx: OrgContext, fetchFn: FetchFn): Promise<RegistryTarget | null> {
  const row = await registryConfigs(ctx, ctx.activeOrgId).findFirst().catch(() => null);
  if (!row?.enabled) return null;
  const creds = decodeRegistryCreds(row.credentialsEnc);
  const authorization = creds ? `Basic ${btoa(`${creds.username}:${creds.password}`)}` : null;
  const nodes = (() => {
    try {
      return ctx.hub.nodeInventory(ctx.activeOrgId);
    } catch {
      return [];
    }
  })();
  for (const base of registryBaseCandidates({ override: process.env.SWARMY_REGISTRY_URL, nodes, registryHost: canonicalRegistryHost(row.host) })) {
    const res = await fetchFn(`${base}/v2/`, {
      headers: authorization ? { authorization } : {},
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (res?.status === 200) return { base, authorization };
  }
  return null;
}

/**
 * The images to label: this controller's BOM with the release's refs and
 * digests, plus components the BOM doesn't know yet (a newer release's). The
 * target's view wins — the upgrade's system step runs on the NEW controller,
 * whose BOM has the new refs. Pure.
 */
export function bundleImages(m: PlatformManifest): SystemImage[] {
  const bom = manifestImages(m).map((img) => {
    const c = m.components[img.key];
    return c?.digest ? { ...img, ref: c.ref, digest: c.digest } : img;
  });
  const known = new Set<string>(bom.map((i) => i.key));
  const extra = Object.entries(m.components)
    .filter(([k, c]) => !known.has(k) && c.digest)
    .map(([k, c]) => ({ key: k as SystemImageKey, ref: c.ref, digest: c.digest }));
  return [...bom, ...extra];
}

/** `<swarmy-system/host/path, tag>` — where the mirror keeps a ref. Pure. */
export function mirrorPathOf(ref: string): { repo: string; tag: string } {
  const p = parseImageRef(ref);
  return { repo: `${SYSTEM_MIRROR_NAMESPACE}/${p.host}/${p.path}`, tag: p.tag ?? 'latest' };
}

async function text(read: ReadAt, e: TarEntry | undefined, what: string): Promise<string> {
  if (!e) throw new Error(`not a swarmy bundle: ${what} is missing`);
  return new TextDecoder().decode(await read(e.offset, e.size));
}

/** Run steps 1–4 over a bundle on disk. Throws a plain-words reason; reports progress as it goes. */
export async function loadBundle(
  ctx: OrgContext,
  file: { read: ReadAt; slice: (offset: number, size: number) => Blob; size: number },
  deps: LoadBundleDeps,
  progress: (p: BundleProgress) => void = () => undefined,
): Promise<{ version: string; images: number }> {
  const entries = await indexTar(file.read, file.size);
  const raw = await text(file.read, bundleEntry(entries, 'platform.json'), 'platform.json');
  const signature = await text(file.read, bundleEntry(entries, 'platform.json.sig'), 'platform.json.sig');
  const rel = verifyRelease(raw, signature);
  if (!rel.manifest) throw new Error(rel.reason ?? 'platform.json is not a platform manifest');
  if (!rel.verified) throw new Error(`unverified release: ${rel.reason ?? 'signature check failed'} — nothing was loaded`);
  const m = rel.manifest;
  const items = Object.entries(m.components).filter(([, c]) => c.digest);
  progress({ version: m.version, total: items.length, done: 0, current: null });

  const target = await deps.registry(ctx, deps.fetch);
  if (!target) throw new Error('the built-in registry is off or unreachable — turn it on in Settings › CI & registry and load the bundle again');
  const blob = (digest: string) => {
    const e = bundleEntry(entries, `oci/blobs/${digest.replace(':', '/')}`);
    return e ? file.slice(e.offset, e.size) : null;
  };
  const pusher = new RegistryPusher(target, blob, deps.fetch);
  const ok = new Map<SystemImageKey, string>();
  const failed: string[] = [];
  for (const [key, c] of items) {
    progress({ current: key, done: ok.size + failed.length });
    const { repo, tag } = mirrorPathOf(c.ref);
    try {
      await pusher.pushImage(repo, tag, c.digest!);
      ok.set(key as SystemImageKey, c.digest!);
    } catch (e) {
      failed.push(`${key} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  progress({ current: null, done: items.length });
  await stampMirrorLabels(ctx, bundleImages(m), ok);
  if (failed.length) throw new Error(`${failed.length} of ${items.length} image(s) did not load: ${failed.join('; ')}`);
  await deps.importRelease(ctx, { manifest: raw, signature }, { adopt: false });
  return { version: m.version, images: ok.size };
}

/** Record what landed as trusted mirror copies on the registry service (the mirror worker's own labels). */
export async function stampMirrorLabels(ctx: OrgContext, images: SystemImage[], ok: Map<SystemImageKey, string>): Promise<void> {
  if (!ok.size) return;
  const state = mirrorStateFrom(ctx.hub.liveInventory(ctx.activeOrgId));
  const manager = ctx.hub.managerNode(ctx.activeOrgId);
  if (!state.registryNodeId || !manager) throw new Error('the registry service is not running — no images can be recorded');
  const { add, removeKeys } = mirrorLabelsAfter(state.labels, state.registryNodeId, ok, images);
  await ctx.hub.dispatch(manager, 'service.updateLabels', { service: REGISTRY_SERVICE_NAME, add, removeKeys });
}
