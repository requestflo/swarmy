/**
 * The images the agent's own one-shot backup/restore sidecars run — restic
 * (volume backups, DB dump storage, compose-DB dumps), wal-g (PITR base
 * backups, restores, window reads, WAL checks) and the Postgres client
 * (pg_dump / pg_restore / psql) — named by their BOM data-image entries.
 *
 * The controller sends each one digest-pinned (`<ref>@<digest>`, tag kept so
 * the version stays readable and restic's version sniff still works) in the
 * fields the payloads already carry (`image`, `resticImage`, `engineImage`,
 * `clientImage`), resolved through the same BOM lookup with the running
 * release's digests as the hub decorator's service pins. Additive: an older
 * agent already honours those fields.
 *
 * An older controller sends nothing (or the bare BOM tag), so the agent falls
 * back to its own default: its compiled BOM entry, digest-pinned where that
 * BOM has a digest. Pure.
 */
import { dataImage, requireDataImage, type DataImageKey } from '../data-images';
import { SYSTEM_IMAGES, type SystemImage } from '../system-images';

export type HelperImage = 'restic' | 'walg' | 'pgClient';

const HELPER_KEYS: Record<HelperImage, DataImageKey> = {
  restic: 'restic',
  walg: 'walg',
  pgClient: requireDataImage('postgres').key,
};

/** `<ref>@<digest>` (tag kept) when the BOM pins a digest, else undefined. */
export function pinnedDataRef(img: SystemImage): string | undefined {
  if (!img.digest || img.ref.includes('@')) return undefined;
  return `${img.ref}@${img.digest}`;
}

/**
 * Controller: each helper at `images`' digests (the running release's BOM).
 * Only digest-pinned refs: a helper the release pins no digest for is left
 * out, so the agent uses its own default rather than a floating tag.
 */
export function pinnedHelperRefs(images: readonly SystemImage[] = SYSTEM_IMAGES): Partial<Record<HelperImage, string>> {
  const out: Partial<Record<HelperImage, string>> = {};
  for (const kind of Object.keys(HELPER_KEYS) as HelperImage[]) {
    const ref = pinnedDataRef(dataImage(HELPER_KEYS[kind], images));
    if (ref) out[kind] = ref;
  }
  return out;
}

/** The agent's own default for a helper: its compiled BOM entry, pinned where it can be. */
export function helperDefault(kind: HelperImage): string {
  const img = dataImage(HELPER_KEYS[kind]);
  return pinnedDataRef(img) ?? img.ref;
}

/**
 * Agent: the image a sidecar runs. What the controller sent wins when it is
 * digest-pinned or another image entirely (an operator's override). Nothing,
 * or the bare BOM tag an older controller sends, falls back to
 * {@link helperDefault}.
 */
export function helperImage(kind: HelperImage, sent: string | undefined): string {
  const s = sent?.trim();
  if (!s || s === dataImage(HELPER_KEYS[kind]).ref) return helperDefault(kind);
  return s;
}
