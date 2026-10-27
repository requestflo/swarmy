import { SNAPSHOT_DATA_ROOT, SNAPSHOT_PATH_RE } from './snapshot-path';

/**
 * Downloading one file or folder out of a volume backup (board 16). Pure
 * rules shared by the tRPC service (path check, size cap), the controller's
 * download route (file name, Content-Disposition) and the dashboard.
 */

/** The controller env var that sets the download cap. */
export const DOWNLOAD_MAX_ENV = 'SWARMY_BACKUP_DOWNLOAD_MAX_BYTES';
/** Default cap on one download: 2 GiB. Bigger saves are restored into a volume instead. */
export const DEFAULT_DOWNLOAD_MAX_BYTES = 2 * 1024 ** 3;

export type SnapshotPathCheck = { ok: true; rel: string; abs: string } | { ok: false; reason: string };

/**
 * A path the person typed or picked, relative to the volume (`config/app.yml`,
 * `/config`, `` for everything), checked to stay inside the snapshot. `..` and
 * `.` are refused, never resolved: a path that needs resolving is a mistake.
 */
export function checkSnapshotPath(input: string): SnapshotPathCheck {
  if (/[\x00-\x1f\x7f]/.test(input)) return { ok: false, reason: 'The path has a control character in it.' };
  const segments = input.trim().split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) {
    return { ok: false, reason: 'The path can’t use “.” or “..” — it has to stay inside this save.' };
  }
  const rel = segments.join('/');
  const abs = rel ? `${SNAPSHOT_DATA_ROOT}/${rel}` : SNAPSHOT_DATA_ROOT;
  if (abs.length > 4096 || !SNAPSHOT_PATH_RE.test(abs)) return { ok: false, reason: 'That path isn’t one this save can have.' };
  return { ok: true, rel, abs };
}

/** `/data/a/b` → `a/b`; `/data` → ``. */
export function relSnapshotPath(abs: string): string {
  return abs === SNAPSHOT_DATA_ROOT ? '' : abs.startsWith(`${SNAPSHOT_DATA_ROOT}/`) ? abs.slice(SNAPSHOT_DATA_ROOT.length + 1) : abs;
}

/** Keep `[A-Za-z0-9._-]`, fold the rest to `_`, never start with a dot. */
function safePart(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').replace(/_+$/, '');
}

/**
 * `<volume>-<path>-<yyyymmdd-hhmm>.tar.gz`: ASCII only, no separators or
 * quotes, at most ~150 characters, so it is safe in a header and on any disk.
 */
export function downloadFileName(p: { volume: string; rel: string; savedAt: Date }): string {
  const stamp = p.savedAt.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const what = [safePart(p.volume) || 'volume', safePart(p.rel.replace(/\//g, '_'))].filter(Boolean).join('-');
  return `${what.slice(0, 120)}-${stamp}.tar.gz`;
}

/** `attachment` with an ASCII `filename` and an RFC 5987 `filename*`. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Parse the cap: plain bytes or `<n>K|M|G|T` (binary). Anything else → the default. */
export function parseDownloadMaxBytes(raw: string | undefined | null): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(raw ?? '');
  if (!m) return DEFAULT_DOWNLOAD_MAX_BYTES;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2]!.toLowerCase() as '' | 'k' | 'm' | 'g' | 't'];
  const bytes = Math.floor(Number(m[1]) * mult);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : DEFAULT_DOWNLOAD_MAX_BYTES;
}

/** Bytes in words: `1.5 GB` (1024-based, like the rest of the Backups page). */
export function bytesWords(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
}

/** The refusal when a download would pass the cap: what, the limit, and the way out. */
export function tooLargeWords(maxBytes: number, sizeBytes?: number): string {
  const what = sizeBytes != null ? `It’s ${bytesWords(sizeBytes)}, and downloads` : 'This download passed the limit: downloads';
  return `${what} stop at ${bytesWords(maxBytes)} (${DOWNLOAD_MAX_ENV} on the controller). Restore the save into a new volume instead, or download a smaller folder.`;
}
