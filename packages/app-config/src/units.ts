/**
 * Human-unit parsers for swarmy.yaml: durations (`15m`, `48h`), sizes
 * (`512mb`, `1gb`) and rates (`100/min`). Pure; every parser returns `null` on
 * a malformed input so the schema layer can turn it into a located issue.
 */

const DURATION_RE = /^(\d+)(s|m|h|d)$/;
const DURATION_UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** `90s` / `15m` / `48h` / `7d` (or a bare number of seconds) → seconds. */
export function parseDuration(v: string | number): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  const m = DURATION_RE.exec(v.trim().toLowerCase());
  if (!m) return null;
  return Number(m[1]) * (DURATION_UNIT[m[2] ?? 's'] ?? 1);
}

const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(k|kb|m|mb|g|gb|t|tb|ki|kib|mi|mib|gi|gib|ti|tib)$/;
const SIZE_MB: Record<string, number> = {
  k: 1 / 1024,
  kb: 1 / 1024,
  ki: 1 / 1024,
  kib: 1 / 1024,
  m: 1,
  mb: 1,
  mi: 1,
  mib: 1,
  g: 1024,
  gb: 1024,
  gi: 1024,
  gib: 1024,
  t: 1024 * 1024,
  tb: 1024 * 1024,
  ti: 1024 * 1024,
  tib: 1024 * 1024,
};

/**
 * `512mb` / `1gb` / `1.5GiB` → whole megabytes (binary: 1gb = 1024mb — the
 * unit Docker memory limits and Valkey maxmemory are reasoned in). A bare
 * number is already megabytes.
 */
export function parseSizeMb(v: string | number): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  const m = SIZE_RE.exec(v.trim().toLowerCase());
  if (!m) return null;
  const mb = Number(m[1]) * (SIZE_MB[m[2] ?? 'mb'] ?? 1);
  return mb >= 1 ? Math.round(mb) : null;
}

const RATE_RE = /^(\d+)\s*\/\s*(s|sec|second|m|min|minute|h|hour)$/;
const RATE_WINDOW: Record<string, number> = {
  s: 1,
  sec: 1,
  second: 1,
  m: 60,
  min: 60,
  minute: 60,
  h: 3600,
  hour: 3600,
};

/** `100/min` → `{ requests: 100, windowSeconds: 60 }` (the ingress RateLimitRule shape). */
export function parseRate(v: string): { requests: number; windowSeconds: number } | null {
  const m = RATE_RE.exec(v.trim().toLowerCase());
  if (!m) return null;
  const requests = Number(m[1]);
  if (requests < 1) return null;
  return { requests, windowSeconds: RATE_WINDOW[m[2] ?? 's'] ?? 1 };
}

/** Five-field cron (the job-scheduler worker's dialect). Shape check only. */
export function isCron(v: string): boolean {
  const fields = v.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f) => /^[\d*,/\-A-Za-z?]+$/.test(f));
}
