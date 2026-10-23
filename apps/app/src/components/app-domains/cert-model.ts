const DAY = 86_400_000;

/** Whole days until a certificate expires (null when unknown). */
export function daysLeft(expiresAt: string | null | undefined, now = Date.now()): number | null {
  if (!expiresAt) return null;
  const t = new Date(expiresAt).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((t - now) / DAY));
}

/** Days until the front door renews it — 30 days before expiry, the rule the Network hub uses. */
export function renewsIn(expiresAt: string | null | undefined, now = Date.now()): number | null {
  const d = daysLeft(expiresAt, now);
  return d === null ? null : Math.max(0, d - 30);
}

/** "22 Dec 2026" */
export function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Where certificates live (`ingress.getConfig` certStorage). */
export function storedIn(cs: { mode: 'shared' | 'local'; bucket: string | null } | undefined): string | null {
  if (!cs) return null;
  return cs.mode === 'shared' && cs.bucket ? cs.bucket : 'each front door’s own disk';
}

/** The rendered Caddyfile in an `ingress.previewConfig` result (a file, or written inside the task). */
export function caddyfileOf(p: {
  files: Array<{ path: string; contents: string }>;
  localReload?: { file?: { path: string; contents: string } } | null;
} | undefined): string | null {
  if (!p) return null;
  const f = p.files.find((x) => /Caddyfile$/.test(x.path)) ?? p.localReload?.file;
  return f && /Caddyfile$/.test(f.path) ? f.contents : null;
}

/** One host's site block from a Caddyfile (`host {` … `}` at column 0), or null. */
export function siteBlock(caddyfile: string, host: string): string | null {
  const lines = caddyfile.split('\n');
  const esc = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const open = new RegExp(`^(https?://)?${esc}(:\\d+)?( |,).*\\{\\s*$`);
  const start = lines.findIndex((l) => open.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^\}\s*$/.test(l));
  return lines.slice(start, end < 0 ? undefined : end + 1).join('\n');
}
