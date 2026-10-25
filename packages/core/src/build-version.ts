/**
 * A build's release version, when one can honestly be read (board 27's
 * "Build v119"): from the git tag the build was asked for, its image tag, or
 * a version-tagged image in the Release its deploy recorded. Never invented —
 * a digest-only release and a branch build have none, and the page keeps the
 * short commit. Pure and browser-safe (the build page and the demo share it).
 */

const SHA = /^[0-9a-f]{7,64}$/;
/** 1.4, 1.4.0, v2.0.0-rc.1, v119 (a lone number needs its v: a bare "42" is just as likely a PR). */
const VERSION = /^(?:v\d+|v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)$/;

/** "refs/tags/v1.4.0" → "v1.4.0"; "1.4.0" → "v1.4.0"; anything else → null. */
export function versionFromTag(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const t = tag.trim().replace(/^refs\/tags\//, '');
  if (SHA.test(t) || !VERSION.test(t)) return null;
  return t.startsWith('v') ? t : `v${t}`;
}

/** The tag part of an image ref ("reg/app:1.4.0@sha256:…" → "1.4.0"), or null. */
function imageTag(image: string): string | null {
  const noDigest = image.split('@')[0] ?? '';
  const last = noDigest.slice(noDigest.lastIndexOf('/') + 1);
  const colon = last.lastIndexOf(':');
  return colon > 0 ? last.slice(colon + 1) : null;
}

export function buildVersion(b: {
  /** `Build.commit`: the sha, or the ref asked for (a branch or a tag). */
  commit: string | null;
  image: string | null;
  /** Images of the Release the deploy after this build recorded. */
  releaseImages?: ReadonlyArray<{ image: string }>;
}): string | null {
  const fromRelease = (b.releaseImages ?? []).map((i) => versionFromTag(imageTag(i.image))).find((v) => v !== null);
  return versionFromTag(b.commit) ?? versionFromTag(b.image ? imageTag(b.image) : null) ?? fromRelease ?? null;
}
