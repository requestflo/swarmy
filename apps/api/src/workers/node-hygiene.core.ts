/**
 * Pure scheduling decision for the node-hygiene worker (unit-tested). No IO.
 *
 * A node is due for a cleanup pass when it has never run this controller
 * lifetime (after the boot grace), when the regular interval elapsed, or —
 * sooner — when its disk is already above the pressure line and the last
 * pass is older than the short pressure cooldown (a filling disk is exactly
 * when reclaiming matters; the cooldown stops a hot loop on a disk that is
 * full of things hygiene must keep).
 */
export const HYGIENE_INTERVAL_MS = 6 * 60 * 60_000;
export const HYGIENE_PRESSURE_PCT = 85;
export const HYGIENE_PRESSURE_COOLDOWN_MS = 30 * 60_000;

export function hygieneDue(input: {
  lastRunMs: number | undefined;
  diskUsedBytes: number | null | undefined;
  diskTotalBytes: number | null | undefined;
  now: number;
}): boolean {
  const { lastRunMs, now } = input;
  if (lastRunMs === undefined) return true;
  const since = now - lastRunMs;
  if (since >= HYGIENE_INTERVAL_MS) return true;
  const total = input.diskTotalBytes ?? 0;
  if (total > 0 && input.diskUsedBytes != null) {
    const pct = (input.diskUsedBytes / total) * 100;
    if (pct > HYGIENE_PRESSURE_PCT && since >= HYGIENE_PRESSURE_COOLDOWN_MS) return true;
  }
  return false;
}
