import type { NodeSummary } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import { bytes } from '@/lib/format';
import { shortName } from './pg-topology';

/**
 * How far behind each standby copy is (board 39), from `db.replication`
 * (`pg_stat_replication` on the main copy): one row per copy, by server, in
 * plain words at Summary and the LSNs at Controls, plus the short stat the
 * diagram's box shows. PURE — tested in pg-replication.test.ts.
 */

export interface PgStandby {
  name: string;
  service: string | null;
  nodeId: string | null;
  state: string | null;
  syncState: string | null;
  sentLsn: string | null;
  replayLsn: string | null;
  lagBytes: number | null;
  lagSeconds: number | null;
}

/** One WAL segment: past this a copy is worth a word even when seconds look fine. */
export const BEHIND_WARN_BYTES = 16 * 1024 * 1024;
export const BEHIND_WARN_SECONDS = 5;

const secs = (s: number): string => `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;

export interface BehindWords {
  say: string;
  /** The diagram box's stat line. */
  short: string;
  word: string;
  tone: Tone;
}

export function behindWords(s: PgStandby): BehindWords {
  const gap = s.lagBytes !== null ? `${bytes(s.lagBytes)} behind${s.lagSeconds !== null ? `, ${secs(s.lagSeconds)}` : ''}` : null;
  if (s.state === 'backup') return { say: 'Copying its first full snapshot from the main copy.', short: 'copying first snapshot', word: 'copying', tone: 'info' };
  if (s.state === 'startup' || s.state === 'catchup') {
    return { say: `Catching up with the main copy${gap ? `: ${gap}` : ''}.`, short: gap ?? 'catching up', word: 'catching up', tone: 'info' };
  }
  if (s.lagBytes === null) return { say: 'Connected; how far behind isn’t measured yet.', short: 'not measured yet', word: 'connected', tone: 'idle' };
  if (s.lagBytes === 0) return { say: 'Caught up: it has every change the main copy has.', short: 'caught up', word: 'caught up', tone: 'ok' };
  const warn = s.lagBytes >= BEHIND_WARN_BYTES || (s.lagSeconds ?? 0) >= BEHIND_WARN_SECONDS;
  return warn
    ? { say: `${gap}. If the main copy failed now, swarmy would hold the switch-over for you.`, short: gap!, word: 'behind', tone: 'warn' }
    : { say: `${gap}: the last changes are on their way.`, short: gap!, word: 'in step', tone: 'ok' };
}

export interface StandbyRow {
  key: string;
  name: string;
  sub: string | undefined;
  say: string;
  tech: string;
  word: string;
  tone: Tone;
}

export function standbyRows(standbys: readonly PgStandby[], nodes: readonly NodeSummary[]): StandbyRow[] {
  return standbys
    .map((s, i) => {
      const n = s.nodeId ? nodes.find((x) => x.id === s.nodeId) : undefined;
      const w = behindWords(s);
      const tech = [
        s.service ? shortName(s.service) : null,
        `replay_lsn ${s.replayLsn ?? '—'}`,
        `sent ${s.sentLsn ?? '—'}`,
        `${s.lagBytes ?? '—'} B`,
        `replay_lag ${s.lagSeconds === null ? 'null' : `${s.lagSeconds} s`}`,
        [s.state, s.syncState].filter(Boolean).join(' · ') || null,
        `task ${s.name}`,
      ].filter(Boolean).join(' · ');
      return { key: `${s.name}#${i}`, name: n?.name ?? (s.service ? shortName(s.service) : s.name), sub: n?.region ?? undefined, say: w.say, tech, word: w.word, tone: w.tone };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** `<service>@<nodeId>` (the diagram's box key) → its stat line. */
export function standbyBoxStats(standbys: readonly PgStandby[]): Map<string, { stat: string; warn: boolean }> {
  const out = new Map<string, { stat: string; warn: boolean }>();
  for (const s of standbys) {
    if (!s.service || !s.nodeId) continue;
    const w = behindWords(s);
    out.set(`${s.service}@${s.nodeId}`, { stat: w.short, warn: w.tone === 'warn' });
  }
  return out;
}
