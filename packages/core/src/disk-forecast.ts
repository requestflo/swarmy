/**
 * Disk-full forecast (plans/epic-volume-mobility.md, phase 5). Pure.
 *
 * Input: a node's disk samples (`MetricSample.diskUsedBytes/diskTotalBytes`,
 * already written by the metrics sampler). Output: the growth rate and how
 * many days until the disk passes the pressure line and until it is full —
 * a least-squares line, like Prometheus `predict_linear`, with two guards
 * that matter on real servers:
 *
 *   - A disk that GREW (total changed: an added/resized volume) restarts the
 *     window at the change — the old trend is against a different ceiling.
 *   - A large DROP in usage (node-hygiene prune, a volume moved off) restarts
 *     the window after it — fitting across it would read as "shrinking".
 *
 * Too few samples or too short a span ⇒ `insufficient-data`, never a guess.
 */

export interface DiskSample {
  /** ms since epoch. */
  ts: number;
  usedBytes: number;
  totalBytes: number;
}

export type DiskForecastStatus = 'growing' | 'stable' | 'insufficient-data' | 'full';

export interface DiskForecast {
  status: DiskForecastStatus;
  /** Fitted growth, bytes/day (0 when not growing or unknown). */
  bytesPerDay: number;
  /** Latest sample. */
  usedBytes: number;
  totalBytes: number;
  usedPct: number;
  /** Days until `pressurePct`; 0 when already past; undefined when not growing. */
  daysToPressure?: number;
  /** Days until 100%. */
  daysToFull?: number;
  /** Goodness of fit, 0..1 (1 = a perfectly steady trend). */
  r2: number;
  /** Samples the fit used. */
  samples: number;
  /** ts of the first sample in the fit. */
  since?: number;
}

export interface ForecastOptions {
  now: number;
  /** Line the alert cares about (node-hygiene prunes past 85%). */
  pressurePct?: number;
  /** Look-back window. */
  windowMs?: number;
  minSamples?: number;
  /** The fit must span at least this long. */
  minSpanMs?: number;
  /** A drop larger than this fraction of the disk restarts the window. */
  dropFraction?: number;
  /** Growth below this is "stable" (noise: logs rotating, temp files). */
  stableBytesPerDay?: number;
}

const DAY_MS = 86_400_000;
export const DISK_FORECAST_WINDOW_MS = 7 * DAY_MS;
export const DISK_FORECAST_PRESSURE_PCT = 85;
/** Forecast alert lines: warn inside two weeks, critical inside three days. */
export const DISK_FORECAST_WARN_DAYS = 14;
export const DISK_FORECAST_CRITICAL_DAYS = 3;

export function forecastDiskFull(samples: readonly DiskSample[], opts: ForecastOptions): DiskForecast {
  const pressurePct = opts.pressurePct ?? DISK_FORECAST_PRESSURE_PCT;
  const windowMs = opts.windowMs ?? DISK_FORECAST_WINDOW_MS;
  const minSamples = opts.minSamples ?? 6;
  const minSpanMs = opts.minSpanMs ?? 6 * 60 * 60_000;
  const dropFraction = opts.dropFraction ?? 0.05;
  const stableBytesPerDay = opts.stableBytesPerDay ?? 50 * 1024 ** 2;

  let pts = samples
    .filter((s) => s.totalBytes > 0 && s.usedBytes >= 0 && s.ts <= opts.now && s.ts >= opts.now - windowMs)
    .slice()
    .sort((a, b) => a.ts - b.ts);

  // Restart at the last capacity change or large drop.
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const grew = Math.abs(cur.totalBytes - prev.totalBytes) > prev.totalBytes * 0.01;
    const dropped = prev.usedBytes - cur.usedBytes > prev.totalBytes * dropFraction;
    if (grew || dropped) start = i;
  }
  pts = pts.slice(start);

  const last = pts[pts.length - 1];
  const base = {
    usedBytes: last?.usedBytes ?? 0,
    totalBytes: last?.totalBytes ?? 0,
    usedPct: last ? (last.usedBytes / last.totalBytes) * 100 : 0,
    samples: pts.length,
    since: pts[0]?.ts,
  };
  if (last && last.usedBytes >= last.totalBytes) {
    return { ...base, status: 'full', bytesPerDay: 0, daysToPressure: 0, daysToFull: 0, r2: 0 };
  }
  if (!last || pts.length < minSamples || last.ts - pts[0]!.ts < minSpanMs) {
    return { ...base, status: 'insufficient-data', bytesPerDay: 0, r2: 0 };
  }

  // Least squares on (days since first sample, used bytes).
  const t0 = pts[0]!.ts;
  const xs = pts.map((p) => (p.ts - t0) / DAY_MS);
  const ys = pts.map((p) => p.usedBytes);
  const n = pts.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  if (slope < stableBytesPerDay) {
    return { ...base, status: 'stable', bytesPerDay: Math.max(0, slope), r2 };
  }
  const daysUntil = (bytes: number) => Math.max(0, (bytes - last.usedBytes) / slope);
  return {
    ...base,
    status: 'growing',
    bytesPerDay: slope,
    daysToPressure: daysUntil((last.totalBytes * pressurePct) / 100),
    daysToFull: daysUntil(last.totalBytes),
    r2,
  };
}

/** Alert severity for a forecast (null = nothing to say). */
export function diskForecastSeverity(f: DiskForecast): 'critical' | 'warning' | null {
  if (f.status === 'full') return 'critical';
  if (f.status !== 'growing' || f.daysToFull === undefined) return null;
  if (f.daysToFull < DISK_FORECAST_CRITICAL_DAYS) return 'critical';
  if (f.daysToFull < DISK_FORECAST_WARN_DAYS) return 'warning';
  return null;
}

/** The Summary-layer sentence for a disk card or an alert. */
export function describeDiskForecast(f: DiskForecast): string {
  const pct = `${Math.round(f.usedPct)}% full`;
  switch (f.status) {
    case 'full':
      return 'The disk is full. Apps and databases on this server can stop writing.';
    case 'insufficient-data':
      return `${pct}. Not enough history yet to say when it fills up.`;
    case 'stable':
      return `${pct} and not growing.`;
    case 'growing': {
      const d = f.daysToFull ?? 0;
      const when = d < 1 ? 'within a day' : d < 60 ? `in about ${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}` : 'in more than two months';
      return `${pct}. At the current rate it fills up ${when}.`;
    }
  }
}
