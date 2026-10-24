/**
 * Seeding the built-in registry from an offline bundle on a node (a fresh
 * air-gapped install: `install-swarmy.sh --bundle`). The installer unpacks the
 * bundle (`scripts/platform-bundle.ts`) into a named volume on node #1 and
 * hands the volume's name to the controller (`SWARMY_BUNDLE_VOLUME`). The
 * controller reads the signed platform.json out of it with a regctl one-shot,
 * verifies it, then copies every image BY DIGEST from the bundle's OCI layout
 * into the registry at the system-image mirror paths — the same copies, and
 * the same `swarmy.mirror.*` labels, as the mirror worker and the bundle
 * upload make (`system-images-bundle.service.ts`).
 *
 * Pure: the one-shot scripts and their output parsers. Unit-tested in
 * `system-images-bundle.test.ts`.
 */
import { MIRROR_FAIL_MARKER, MIRROR_LABEL_PREFIX, MIRROR_OK_MARKER, copyTargetFor, type SystemImage } from './system-images';

/** Where the one-shots mount the bundle volume (read-only). */
export const BUNDLE_MOUNT = '/bundle';
/** The bundle's top directory inside the volume (the tar's `swarmy-bundle/`). */
export const BUNDLE_ROOT = `${BUNDLE_MOUNT}/swarmy-bundle`;
/** Registry service label: the release a bundle seeded (the controller stops looking once it is set). */
export const MIRROR_BUNDLE_LABEL = `${MIRROR_LABEL_PREFIX}bundle`;

export const BUNDLE_MANIFEST_MARKER = '@@SWARMY-BUNDLE-MANIFEST@@';
export const BUNDLE_SIG_MARKER = '@@SWARMY-BUNDLE-SIG@@';
export const BUNDLE_NONE_MARKER = '@@SWARMY-BUNDLE-NONE@@';
export const MIRROR_SKIP_MARKER = '@@SWARMY-MIRROR-SKIP@@';

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const B64_RE = /^[A-Za-z0-9+/=]+$/;

function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Print the signed manifest + signature as base64 (one line each: the bytes
 * the release key signed survive the log stream untouched), or the none marker.
 */
export function renderBundleReadScript(root: string = BUNDLE_ROOT): string {
  const m = sq(`${root}/platform.json`);
  const s = sq(`${root}/platform.json.sig`);
  return [
    'set -u',
    `if [ -s ${m} ] && [ -s ${s} ]; then`,
    `  echo "${BUNDLE_MANIFEST_MARKER} $(base64 -w0 ${m})"`,
    `  echo "${BUNDLE_SIG_MARKER} $(base64 -w0 ${s})"`,
    `else echo "${BUNDLE_NONE_MARKER}"; fi`,
  ].join('\n');
}

/** The read one-shot's output → the manifest bytes + signature, or null (no bundle there). */
export function parseBundleRead(output: string): { manifest: string; signature: string } | null {
  let manifest: string | null = null;
  let signature: string | null = null;
  for (const line of output.split('\n')) {
    const [marker, b64 = ''] = line.trim().split(/\s+/);
    if (!B64_RE.test(b64)) continue;
    if (marker === BUNDLE_MANIFEST_MARKER) manifest = Buffer.from(b64, 'base64').toString('utf8');
    else if (marker === BUNDLE_SIG_MARKER) signature = Buffer.from(b64, 'base64').toString('utf8');
  }
  return manifest && signature ? { manifest, signature } : null;
}

/**
 * The copier: each image by its signed digest from the bundle's OCI layout to
 * its mirror path. An image the bundle doesn't hold (no index blob) prints the
 * skip marker; a copy prints the mirror copier's OK/FAIL markers, so
 * `parseMirrorOutput` + `mirrorLabelsAfter` take it from there.
 */
export function renderBundleCopyScript(items: readonly SystemImage[], registryHost: string, root: string = BUNDLE_ROOT): string {
  const lines = [
    'set -u',
    `regctl registry set ${sq(registryHost)} --tls disabled >/dev/null 2>&1 || true`,
    `if [ -n "\${SWARMY_REG_USER:-}" ]; then printf '%s' "$SWARMY_REG_PASS" | regctl registry login ${sq(registryHost)} -u "$SWARMY_REG_USER" --pass-stdin >/dev/null 2>&1 || true; fi`,
  ];
  for (const img of items) {
    if (!img.digest || !DIGEST_RE.test(img.digest)) continue;
    const blob = sq(`${root}/oci/blobs/sha256/${img.digest.slice('sha256:'.length)}`);
    const dst = sq(copyTargetFor(img, registryHost));
    lines.push(
      `if [ ! -s ${blob} ]; then echo "${MIRROR_SKIP_MARKER} ${img.key}"; ` +
        `elif regctl image copy ${sq(`ocidir://${root}/oci@${img.digest}`)} ${dst} >/dev/null 2>&1 && D=$(regctl image digest ${dst} 2>/dev/null); ` +
        `then echo "${MIRROR_OK_MARKER} ${img.key} $D"; else echo "${MIRROR_FAIL_MARKER} ${img.key}"; fi`,
    );
  }
  return lines.join('\n');
}

/** Keys the copier skipped (not in this bundle). */
export function parseBundleSkipped(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((t) => t[0] === MIRROR_SKIP_MARKER && t[1])
    .map((t) => t[1]!);
}
