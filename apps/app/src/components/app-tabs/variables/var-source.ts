import type { Tone } from '@/components/calm';
import { relTime } from '@/lib/format';
import type { TableRow } from './var-table-model';

/** Where a row's value comes from, in plain words, and the tone of that word. */
export function sourceOf(row: TableRow): { word: string; tone: Tone | null } {
  switch (row.kind) {
    case 'binding':
      return { word: 'from a connection', tone: 'info' };
    case 'swarmy':
      return { word: 'swarmy', tone: 'ok' };
    case 'secretVar': {
      const v = row.targets?.[0]?.view;
      return { word: `secret · changed ${relTime(v?.updatedAt)}${v?.updatedBy ? ` by ${v.updatedBy}` : ''}`, tone: null };
    }
    case 'family': {
      const f = row.family!;
      if (f.staleConsumers > 0) return { word: `secret · ${f.staleConsumers} on an old one`, tone: 'warn' };
      return { word: `secret · changed ${relTime(f.lastRotatedAt)}`, tone: null };
    }
    default:
      return { word: 'you', tone: null };
  }
}

/** " · all" · " · api, checkout" · " · not used yet". */
export function scopeWords(row: TableRow, total: number): string {
  if (row.services.length === 0) return 'not used yet';
  if (total > 1 && row.services.length === total) return 'all';
  return row.services.length > 3 ? `${row.services.slice(0, 3).join(', ')} +${row.services.length - 3}` : row.services.join(', ');
}

/** The tech line under a row (Controls up): where it lives and how it reaches the app. */
export function techOf(row: TableRow): string | null {
  if (row.kind === 'binding') return 'swarmy fills this in on each deploy, so the password never leaves the swarm';
  if (row.kind === 'family') {
    const f = row.family!;
    return `v${f.currentVersion} of ${f.versions.length} · /run/secrets/${f.family} · write-only`;
  }
  if (row.kind === 'secretVar') {
    const t = row.targets ?? [];
    const v = t[0]?.view;
    return v ? `Docker secret ${v.secretName} · reaches ${t.map((x) => x.name).join(', ')} ${v.delivery === 'file' ? `as /run/secrets/${row.key}` : 'as an env var'}` : null;
  }
  return null;
}
