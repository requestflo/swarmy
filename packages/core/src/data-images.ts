/**
 * Lookups over the BOM's data-images section (`system-images-data.ts`): the
 * one way managed-data code names an image.
 *
 * A service names an entry (`dataImage('restic')`, `dataImageFor('postgres',
 * '16')`) and dispatches its bare ref. The hub dispatch decorator then deploys
 * it at the running release's digest when that release pins one, else by the
 * tag, or from the built-in registry's copy once a bundle seeded it
 * (`pinSystemImages` / `rewriteSystemImages` over `effectiveImagesFor`) — one
 * place for every managed service. A data image deploys as `<ref>@<digest>`,
 * tag kept (`dataDeployRef`): the tag is the engine version people read, and a
 * re-provision carries the live image forward through `dataImageOfRef`.
 *
 * Pure. Unit-tested in `data-images.test.ts`.
 */
import { DATA_IMAGES, type DataEngine, type DataImage, type DataImageKey } from './system-images-data';
import { SYSTEM_IMAGES, SYSTEM_MIRROR_NAMESPACE, parseImageRef, type SystemImage } from './system-images';

export { DATA_IMAGES, POSTGRES_MAJORS } from './system-images-data';
export type { DataEngine, DataImage, DataImageKey, DataImageRole } from './system-images-data';

const ENGINE_ROLES = new Set<string>(['postgres', 'cache', 'search', 'vector']);
const KEYS = new Set<string>(DATA_IMAGES.map((i) => i.key));

export function isDataImageKey(key: string): key is DataImageKey {
  return KEYS.has(key);
}

/** A data-section entry (a manifest-filled copy keeps its role). */
export function isDataImage(img: SystemImage | undefined): img is DataImage {
  return Boolean(img && 'role' in img && isDataImageKey(img.key));
}

export function dataImage(key: DataImageKey, images: readonly SystemImage[] = SYSTEM_IMAGES): DataImage {
  const hit = images.find((i) => i.key === key);
  if (!isDataImage(hit)) throw new Error(`unknown data image ${key}`);
  return hit;
}

/** The images that run `engine` (one per major it offers). */
export function engineImages(engine: DataEngine): DataImage[] {
  return DATA_IMAGES.filter((i) => ENGINE_ROLES.has(i.role) && i.engine === engine);
}

/** The engine majors swarmy offers, oldest first. */
export function offeredMajors(engine: DataEngine): string[] {
  return engineImages(engine).flatMap((i) => i.majors);
}

/**
 * The image for a user's choice of `engine` and `major`; no major = the
 * engine's default. Undefined when swarmy doesn't offer that major.
 */
export function dataImageFor(engine: DataEngine, major?: string): DataImage | undefined {
  const all = engineImages(engine);
  if (major !== undefined) return all.find((i) => i.majors.includes(major.trim()));
  return all.find((i) => i.default) ?? (all.length === 1 ? all[0] : undefined);
}

/** {@link dataImageFor} for code that only ever asks for what the BOM offers. */
export function requireDataImage(engine: DataEngine, major?: string): DataImage {
  const hit = dataImageFor(engine, major);
  if (!hit) throw new Error(`swarmy offers no ${engine}${major ? ` ${major}` : ''} image`);
  return hit;
}

/** `host/path` + tag of a ref, with a mirror prefix (`<registry>/swarmy-system/`) stripped. */
function upstreamOf(image: string): { repo: string; tag: string | null; digest: string | null } {
  const p = parseImageRef(image);
  const ns = `${SYSTEM_MIRROR_NAMESPACE}/`;
  if (p.path.startsWith(ns)) {
    const inner = parseImageRef(p.path.slice(ns.length));
    return { repo: `${inner.host}/${inner.path}`, tag: p.tag, digest: p.digest };
  }
  return { repo: `${p.host}/${p.path}`, tag: p.tag, digest: p.digest };
}

/**
 * The entry a live image runs, whatever form Swarm reports it in: the BOM ref,
 * `<ref>@<digest>`, the fully-qualified name, or the built-in registry's copy.
 * Matched by repository and tag (by digest when the form has no tag).
 * Undefined for anything else (a private mirror, a tag the BOM doesn't list).
 */
export function dataImageOfRef(image: string, images: readonly SystemImage[] = SYSTEM_IMAGES): DataImage | undefined {
  const live = upstreamOf(image);
  return images.filter(isDataImage).find((img) => {
    const want = upstreamOf(img.ref);
    if (want.repo !== live.repo) return false;
    return live.tag ? live.tag === want.tag : Boolean(live.digest && live.digest === img.digest);
  });
}

/**
 * How a data image deploys once its digest is known: `<repo>:<tag>@<digest>`.
 * `pinned` is the digest ref the decorator chose (`<repo>@<digest>`, upstream or
 * mirrored); the entry's tag goes back in front of the digest.
 */
export function dataDeployRef(pinned: string, img: SystemImage): string {
  const at = pinned.lastIndexOf('@');
  const tag = parseImageRef(img.ref).tag;
  if (at < 0 || !tag) return pinned;
  const repo = pinned.slice(0, at);
  return parseImageRef(repo).tag ? pinned : `${repo}:${tag}${pinned.slice(at)}`;
}
