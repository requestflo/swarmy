export function bytes(n: number | null | undefined): string {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function bps(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${bytes(n)}/s`;
}

export function pct(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n.toFixed(n >= 100 ? 0 : 1)}%`;
}

export function cores(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n} ${n === 1 ? 'core' : 'cores'}`;
}

export function relTime(value: string | Date | null | undefined): string {
  if (!value) return 'never';
  const t = typeof value === 'string' ? new Date(value).getTime() : value.getTime();
  const diff = Date.now() - t;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
