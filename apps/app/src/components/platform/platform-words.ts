/**
 * Plain words for Settings → Platform. Pure, so the page and its tests agree.
 */

/** Older than this and the page re-checks the feed on open. */
export const CHECK_STALE_MS = 10 * 60_000;

function ago(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** "Checked 12 min ago" / "Never checked" / "The last check failed 2 h ago". */
export function checkedWords(lastCheckAt: string | null, lastCheckError: string | null, now = Date.now()): string {
  const t = lastCheckAt ? new Date(lastCheckAt).getTime() : NaN;
  if (!Number.isFinite(t) || t <= 0) return 'Never checked';
  const when = ago(Math.max(0, now - t));
  return lastCheckError ? `The last check failed ${when}` : `Checked ${when}`;
}

/** Whether opening the page should re-check the feed (never checked, or older than 10 min). */
export function checkIsStale(lastCheckAt: string | null, now = Date.now(), maxAgeMs = CHECK_STALE_MS): boolean {
  const t = lastCheckAt ? new Date(lastCheckAt).getTime() : NaN;
  return !Number.isFinite(t) || t <= 0 || now - t > maxAgeMs;
}

/**
 * What has to happen before Upgrade can pass preflight. Preflight takes a
 * fresh backup of swarmy itself, and that backup needs a restore passphrase;
 * without one the upgrade stops at step one. `null` = nothing in the way (or
 * not known yet — the upgrade button shows and preflight still guards).
 */
export function upgradePrereq(backup: { hasPassphrase: boolean } | null | undefined): 'passphrase' | null {
  return backup && !backup.hasPassphrase ? 'passphrase' : null;
}
