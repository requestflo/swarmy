import type { DbBackupSnapshotView, ReleaseView } from '@swarmy/core';
import type { DbRestoreMode } from '@swarmy/core/protocol';
import { releaseLabel } from '@/components/app-tabs/releases/release-label';

/**
 * What ran at a moment, pure. Every deploy records the image of every part
 * (`releases.list` → `images`), so the release in effect at T — the newest
 * one created at or before T — is the app as it was then. "Changes since T"
 * are the releases after it; the nearest restore point is the newest database
 * save at or before T (the earliest after it when none is older).
 */

const ms = (iso: string): number => new Date(iso).getTime();

/** "ghcr.io/northwind/storefront-web:1.9.0" → "1.9.0"; a digest → its first 12 hex; no tag → "latest". */
export function imageTag(image: string): string {
  const at = image.lastIndexOf('@');
  if (at > 0) return image.slice(at + 1).replace(/^sha256:/, '').slice(0, 12);
  const colon = image.lastIndexOf(':');
  const tag = colon > image.lastIndexOf('/') ? image.slice(colon + 1) : '';
  return tag || 'latest';
}

/** Newest first, as `releases.list` returns them — re-sorted so callers needn't trust the order. */
const newestFirst = (rows: ReleaseView[]): ReleaseView[] => [...rows].sort((a, b) => ms(b.createdAt) - ms(a.createdAt));

/** The release in effect at T: the newest one created at or before it (null before the first on record). */
export function releaseAt(releases: ReleaseView[], t: number): ReleaseView | null {
  return newestFirst(releases).find((r) => ms(r.createdAt) <= t) ?? null;
}

export interface ReplayPart {
  name: string;
  image: string;
  tag: string;
  /** The tag the part runs now; null when today's release no longer has it. */
  nowTag: string | null;
  changed: boolean;
}

/** A part today's app has that wasn't there at T, and the release that brought it. */
export interface LaterPart {
  name: string;
  label: string;
  at: number;
}

export interface Replay {
  release: ReleaseView | null;
  parts: ReplayPart[];
  later: LaterPart[];
}

/** Each part → its image then and whether it has changed since; parts added after T come back as `later`. */
export function replayAt(releases: ReleaseView[], t: number): Replay {
  const rows = newestFirst(releases);
  const release = releaseAt(rows, t);
  if (!release) return { release: null, parts: [], later: [] };
  const now = new Map((rows[0]?.images ?? []).map((i) => [i.name, i.image]));
  const parts = release.images.map((i) => {
    const current = now.get(i.name);
    return { name: i.name, image: i.image, tag: imageTag(i.image), nowTag: current ? imageTag(current) : null, changed: current !== i.image };
  });
  const then = new Set(release.images.map((i) => i.name));
  const after = rows.filter((r) => ms(r.createdAt) > t).reverse();
  const later = [...now.keys()]
    .filter((name) => !then.has(name))
    .map((name) => {
      const first = after.find((r) => r.images.some((i) => i.name === name));
      return { name, label: releaseLabel(first), at: first ? ms(first.createdAt) : NaN };
    });
  return { release, parts, later };
}

export interface Change {
  id: string;
  /** "v1.9.0". */
  label: string;
  at: number;
  status: ReleaseView['status'];
  /** Parts whose image this release changed (new parts included). */
  parts: string[];
  /** Parts this release dropped. */
  removed: string[];
  /** It redeployed an earlier release (`notes` names the one it put back). */
  putBack: boolean;
}

/** The releases after T, newest first, each with the parts it changed against the one before it. */
export function changesSince(releases: ReleaseView[], t: number): Change[] {
  const rows = newestFirst(releases);
  const out: Change[] = [];
  rows.forEach((r, i) => {
    if (ms(r.createdAt) <= t) return;
    const before = new Map((rows[i + 1]?.images ?? []).map((x) => [x.name, x.image]));
    const names = new Set(r.images.map((x) => x.name));
    out.push({
      id: r.id,
      label: releaseLabel(r),
      at: ms(r.createdAt),
      status: r.status,
      parts: r.images.filter((x) => before.get(x.name) !== x.image).map((x) => x.name),
      removed: [...before.keys()].filter((n) => !names.has(n)),
      putBack: /\brollback\b/i.test(r.notes ?? ''),
    });
  });
  return out;
}

export interface RestorePoint {
  backup: DbBackupSnapshotView;
  at: number;
  /** False when the only saves are newer than T: the nearest is after it. */
  before: boolean;
}

/** The newest database save at or before T; failing that, the earliest one after it. */
export function nearestRestorePoint(backups: DbBackupSnapshotView[], t: number): RestorePoint | null {
  const dated = backups.map((b) => ({ backup: b, at: ms(b.time) })).filter((x) => Number.isFinite(x.at)).sort((a, b) => a.at - b.at);
  const older = dated.filter((x) => x.at <= t).at(-1);
  if (older) return { ...older, before: true };
  const newer = dated[0];
  return newer ? { ...newer, before: false } : null;
}

/**
 * Where a point-in-time restore can land for T: T itself inside the
 * cluster's recoverable span (`dbBackups.overview` → `pitrWindow`), clamped
 * to its ends outside it; without a span, the base save's own time.
 */
export function pitrTarget(t: number, window: { from: string; to: string } | null, savedAt: number): number {
  if (!window) return savedAt;
  const from = ms(window.from);
  const to = ms(window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return savedAt;
  return Math.min(to, Math.max(from, t));
}

/**
 * The restore modes a save allows (dbBackup.service invariant: logical dumps
 * restore as clone / in-place, physical base backups only point-in-time, which
 * replaces the live data). No copy for a physical save.
 */
export function restoreModes(engine: DbBackupSnapshotView['engine']): { copy: DbRestoreMode | null; replace: DbRestoreMode } {
  const physical = engine === 'wal-g' || engine === 'pgbackrest';
  return physical ? { copy: null, replace: 'pitr' } : { copy: 'clone-to-new-cluster', replace: 'in-place' };
}
