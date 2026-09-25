import type { Tone } from '@/components/calm';
import { fmtBytes, relativeTime } from '@/components/backups/backup-format';

/** One thing an app keeps, said plainly. `risk` orders the "least protected" pick (higher = worse). */
export interface DataItem {
  key: string;
  app: string;
  kind: 'Postgres' | 'Cache' | 'Search' | 'Vectors' | 'Bucket';
  name: string;
  say: string;
  tech: string;
  tone: Tone;
  word: string;
  risk: number;
  /** For Postgres: can "save it now". */
  cluster?: string;
}

/** "0 3 * * *" → "nightly at 03:00"; anything else stays as the cron. */
export function scheduleWords(cron: string | null): string {
  if (!cron) return 'on a schedule';
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron.trim());
  if (m) return `nightly at ${m[2]!.padStart(2, '0')}:${m[1]!.padStart(2, '0')}`;
  if (/^0 \* \* \* \*$/.test(cron.trim())) return 'every hour';
  return `on “${cron}”`;
}

interface PgRow {
  stack: string;
  cluster: string;
  scheduled: boolean;
  cron: string | null;
  engine: string | null;
  retentionDays: number | null;
  pitr: boolean;
  targetName: string | null;
  lastBackupAt: string | null;
  lastStatus: string | null;
  lastSizeBytes: string | null;
}

const DAY = 86_400_000;

export function pgItem(r: PgRow): DataItem {
  const base = { key: `pg:${r.stack}/${r.cluster}`, app: r.stack, kind: 'Postgres' as const, name: r.cluster, cluster: r.cluster };
  const tech = `${r.engine ?? 'no engine'} · ${r.cron ?? 'no schedule'} · keep ${r.retentionDays ?? '–'}d · ${r.targetName ?? 'no target'}${r.pitr ? ' · pitr' : ''}`;
  if (!r.scheduled) return { ...base, tech, say: 'Not backed up. If its server is lost, so is the data.', tone: 'warn', word: 'Needs you', risk: 90 };
  if (r.lastStatus === 'failed') return { ...base, tech, say: `The last save failed (${relativeTime(r.lastBackupAt)}).`, tone: 'bad', word: 'Needs you', risk: 100 };
  const stale = !r.lastBackupAt || Date.now() - new Date(r.lastBackupAt).getTime() > 2 * DAY;
  const when = r.pitr ? 'saved continuously, back to any minute' : `saved ${scheduleWords(r.cron)}`;
  const last = r.lastBackupAt ? `last ${relativeTime(r.lastBackupAt)}${r.lastSizeBytes ? `, ${fmtBytes(r.lastSizeBytes)}` : ''}` : 'no save yet';
  return {
    ...base,
    tech,
    say: `${when[0]!.toUpperCase()}${when.slice(1)} · ${last}`,
    tone: stale ? 'warn' : 'ok',
    word: stale ? 'Needs you' : 'Safe',
    risk: stale ? 60 : r.pitr ? 0 : 10,
  };
}

export function cacheItem(c: { stack: string; name: string; engine: string; memoryMb: number; replicas: { desired: number; running: number } }): DataItem {
  const copies = c.replicas.desired;
  return {
    key: `cache:${c.stack}/${c.name}`,
    app: c.stack,
    kind: 'Cache',
    name: c.name,
    say: copies > 0 ? `In memory, with ${copies} standby cop${copies === 1 ? 'y' : 'ies'}` : 'In memory only. The app rebuilds it after a restart.',
    tech: `${c.engine} · ${c.memoryMb} MB · replicas ${c.replicas.running}/${c.replicas.desired}`,
    tone: copies > 0 ? 'ok' : 'idle',
    word: copies > 0 ? 'Safe' : 'Rebuildable',
    risk: copies > 0 ? 5 : 20,
  };
}

export function indexItem(kind: 'Search' | 'Vectors', s: { stack: string; name: string; engine: string }): DataItem {
  return {
    key: `${kind}:${s.stack}/${s.name}`,
    app: s.stack,
    kind,
    name: s.name,
    say: 'An index. It can be rebuilt from the app’s own data.',
    tech: s.engine,
    tone: 'idle',
    word: 'Rebuildable',
    risk: 15,
  };
}

export function bucketItem(b: { name: string; usageBytes: number; objects: number }, app: string, copies: number): DataItem {
  return {
    key: `bucket:${b.name}`,
    app,
    kind: 'Bucket',
    name: b.name,
    say: `${fmtBytes(b.usageBytes)} in ${b.objects.toLocaleString()} files · kept on ${copies} server${copies === 1 ? '' : 's'}`,
    tech: `garage · replication ${copies}`,
    tone: copies > 1 ? 'ok' : 'warn',
    word: copies > 1 ? 'Safe' : 'One copy',
    risk: copies > 1 ? 5 : 50,
  };
}
