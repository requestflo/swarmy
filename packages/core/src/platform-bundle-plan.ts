/**
 * What an offline bundle carries (`scripts/platform-bundle.ts`): every image a
 * node of the release can pull. The list comes from the BOM
 * (`system-images.ts`), so nothing is missed — the registry forwarder's Caddy,
 * the NetBird client, relay and server, and every other system image — at the
 * digests the release's signed platform.json names.
 *
 *  - A BOM entry the release names with a digest: that digest (own builds,
 *    and pins the release kept).
 *  - A pinned third-party BOM entry the release doesn't name (a bundle built
 *    from a newer checkout): the BOM pin. Harmless, and the node has it.
 *  - A component the release names WITHOUT a digest: unresolved. A node of
 *    that release would pull it, so a bundle without it is incomplete — the
 *    script refuses.
 *  - A floating own build the release doesn't name at all: that release's
 *    controller never runs it (skipped, reported).
 *  - A component the release names that this BOM doesn't know (a newer
 *    release): bundled when it has a digest.
 *
 * Parts: the data images (the BOM's data section: managed Postgres, caches,
 * search, vector and their backup helpers) are about 2 GB of the bundle, so
 * `--without data-images` leaves them out (`omitted`). Such a bundle installs
 * and upgrades a cluster that runs no managed data.
 *
 * Pure. `platform-bundle-plan.test.ts` proves the plan covers the BOM.
 */
import { isDataImageKey } from './data-images';
import type { PlatformManifest } from './platform-manifest';
import { SYSTEM_IMAGES, copySourceFor, type SystemImage } from './system-images';

/** Parts of the bundle an operator may leave out. */
export const BUNDLE_PARTS = ['data-images'] as const;
export type BundlePart = (typeof BUNDLE_PARTS)[number];
/** The bundle's list of the components it left out on purpose (one key per line). */
export const BUNDLE_OMITTED_FILE = 'omitted.txt';

export interface BundleImage {
  /** BOM / component key: the image's tag in the bundle's OCI layout (`oci:<key>`). */
  key: string;
  /** The ref swarmy's code dispatches (and the mirror path the image lands under). */
  ref: string;
  /** What the bundle script copies: `<repository>@<digest>`. */
  source: string;
  digest: string;
}

export interface BundlePlan {
  images: BundleImage[];
  /** Named by the release (or floating in the BOM) with no digest: the bundle can't carry them. */
  unresolved: string[];
  /** Floating own builds this release doesn't name (its controller never runs them). */
  notInRelease: string[];
  /** Components a part the operator left out holds (`--without`). */
  omitted: string[];
}

export function planBundle(
  m: PlatformManifest,
  bom: readonly SystemImage[] = SYSTEM_IMAGES,
  opts: { without?: readonly BundlePart[] } = {},
): BundlePlan {
  const plan: BundlePlan = { images: [], unresolved: [], notInRelease: [], omitted: [] };
  const known = new Set<string>();
  const leaveOut = (key: string) => Boolean(opts.without?.includes('data-images') && isDataImageKey(key));
  for (const img of bom) {
    known.add(img.key);
    if (leaveOut(img.key)) {
      if (m.components[img.key]) plan.omitted.push(img.key);
      continue;
    }
    const c = m.components[img.key];
    if (c?.digest) plan.images.push({ key: img.key, ref: c.ref, source: `${c.image}@${c.digest}`, digest: c.digest });
    else if (c) plan.unresolved.push(img.key);
    else if (img.digest) plan.images.push({ key: img.key, ref: img.ref, source: copySourceFor(img), digest: img.digest });
    else plan.notInRelease.push(img.key);
  }
  for (const [key, c] of Object.entries(m.components)) {
    if (known.has(key)) continue;
    if (leaveOut(key)) {
      plan.omitted.push(key);
      continue;
    }
    if (c.digest) plan.images.push({ key, ref: c.ref, source: `${c.image}@${c.digest}`, digest: c.digest });
    else plan.unresolved.push(key);
  }
  return plan;
}
