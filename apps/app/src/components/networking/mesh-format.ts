export type MeshDriverId = 'none' | 'netbird' | 'headscale';

export const DRIVER_LABELS: Record<MeshDriverId, string> = {
  none: 'None',
  netbird: 'NetBird',
  headscale: 'Headscale (advanced)',
};

/** "4 s ago" / "3 min ago" / "2 h ago" / "3 d ago" — seconds matter for a peer's last word. */
export function seenAgo(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** "25 min left" / "6 h left" / "expired" for a grant's expiry; null = no expiry. */
export function timeLeft(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'expired';
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m} min left`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h left` : `${Math.round(h / 24)} d left`;
}
