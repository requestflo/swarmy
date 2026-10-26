/**
 * Pure: board 16's "Offsite copy · 4 min behind", for a destination that
 * schedules also copy to (`backups.copyLag`). The words say how far the
 * second copy trails the first, and what is wrong when something is.
 */
import type { inferOutput, TRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { AppRouter } from '@swarmy/trpc';
import type { Tone } from '@/components/calm/tone';
import { fmtBytes } from './backup-format';

export type CopyLag = inferOutput<TRPCOptionsProxy<AppRouter>['backups']['copyLag']>[number];

const MIN = 60_000;
const HOUR = 60 * MIN;
/** A nightly copy that missed one run is this far behind. */
const STALE_MS = 26 * HOUR;

/** "4 min", "3 h", "2 days". */
export function lagWords(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))} min`;
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / (24 * HOUR))} days`;
}

const vols = (n: number): string => `${n} volume${n === 1 ? '' : 's'}`;

/** The row's sentence, its tone and its tech line. */
export function copyLagLine(l: CopyLag): { say: string; tone: Tone; tech: string } {
  const tech = [
    `also copy to · ${l.schedules} schedule${l.schedules === 1 ? '' : 's'}`,
    l.newestCopyAt ? `newest copy ${l.newestCopyAt.slice(0, 16).replace('T', ' ')} UTC` : null,
    l.copiedBytes !== '0' ? fmtBytes(l.copiedBytes) : null,
    l.lastError ? `last error: ${l.lastError}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (l.failing > 0) return { say: `Second copy · the last copy of ${vols(l.failing)} failed`, tone: 'bad', tech };
  if (l.neverCopied > 0) return { say: `Second copy · ${vols(l.neverCopied)} not copied yet`, tone: 'warn', tech };
  if (l.behindMs == null) return { say: l.copying > 0 ? 'Second copy · copying now' : 'Second copy · nothing saved yet', tone: 'idle', tech };
  const behind = l.behindMs < MIN ? 'up to date' : `${lagWords(l.behindMs)} behind`;
  const now = l.copying > 0 ? ' · copying now' : '';
  return { say: `Second copy · ${behind}${now}`, tone: l.behindMs > STALE_MS ? 'warn' : 'ok', tech };
}
