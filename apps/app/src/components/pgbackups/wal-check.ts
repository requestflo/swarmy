/**
 * What the WAL check (`dbBackups.walCheck`) means on the restore card: one
 * line ("WAL is continuous since …" or the gap a restore can't land inside),
 * and the stretches of the scrubber no restore can reach. A gap blocks from
 * its start until the first base copy taken after it (forever, with none).
 */
import type { DbWalCheckView } from '@swarmy/core';
import { formatPit, type PitSpan } from './pitr-scrub';

export interface WalLine {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
  tech: string;
}

const at = (iso: string | null): string => (iso ? `${formatPit(Date.parse(iso))} UTC` : 'an unknown time');

/** The line, or null when there is no read to speak from. */
export function walLine(v: DbWalCheckView | null | undefined): WalLine | null {
  if (!v || v.source !== 'agent' || !v.status) return null;
  const tech = `wal-g wal-verify integrity timeline · ${v.gaps.length} gap${v.gaps.length === 1 ? '' : 's'}${
    v.pendingSegments ? ` · ${v.pendingSegments} newest segment${v.pendingSegments === 1 ? '' : 's'} still uploading` : ''
  }${v.timeline && v.timeline !== 'ok' ? ` · timeline ${v.timeline}` : ''}`;
  const g = v.gaps.at(-1);
  if (!g) {
    return { tone: 'ok', text: `WAL is continuous${v.continuousSince ? ` since ${at(v.continuousSince)}` : ''} · 0 gaps.`, tech };
  }
  const more = v.gaps.length > 1 ? ` (and ${v.gaps.length - 1} earlier)` : '';
  const after = g.reachableAgainAt
    ? ` Times from ${at(g.reachableAgainAt)} restore again from the base copy taken after it.`
    : ' Nothing after it can be restored until a new base copy is taken.';
  return {
    tone: g.reachableAgainAt ? 'warn' : 'bad',
    text: `WAL has a gap from ${at(g.from)} to ${at(g.to)}${more}: a restore can't land inside it.${after}`,
    tech,
  };
}

/** The scrubber stretches no restore can reach, clipped to the span. */
export function walBlocked(v: DbWalCheckView | null | undefined, span: PitSpan): Array<{ fromMs: number; toMs: number }> {
  if (!v || v.source !== 'agent') return [];
  return v.gaps
    .map((g) => ({
      fromMs: Math.max(span.fromMs, g.from ? Date.parse(g.from) : span.fromMs),
      toMs: Math.min(span.toMs, g.reachableAgainAt ? Date.parse(g.reachableAgainAt) : span.toMs),
    }))
    .filter((b) => b.toMs > b.fromMs);
}

/** Is this time inside one of them? */
export function isBlocked(ms: number, blocked: ReadonlyArray<{ fromMs: number; toMs: number }>): boolean {
  return blocked.some((b) => ms > b.fromMs && ms < b.toMs);
}
