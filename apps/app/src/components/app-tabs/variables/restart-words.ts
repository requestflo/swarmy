import type { ServiceSpec } from '@swarmy/core/protocol';
import { orderOf, parallelismOf, rolloutSeconds } from '@/components/service-settings/settings-model';

/** How one service picks up a change: its copies and its rolling-update policy, read from the live spec. */
export interface RestartLine {
  name: string;
  copies: number;
  /** "2 copies · one at a time" / "1 copy · starts new before stopping old". */
  words: string;
  /** Rollout time from the health check; null when there is none to time it by. */
  seconds: number | null;
  /** True when every copy is down at once for a moment (stop-first, no copy left serving). */
  gap: boolean;
}

const batch = (p: number): string => (p === 1 ? 'one' : String(p));

export function restartLine(name: string, copies: number, spec: ServiceSpec | null | undefined): RestartLine {
  const s = spec ?? null;
  const p = parallelismOf(s);
  const startFirst = orderOf(s) === 'start-first';
  const n = `${copies} ${copies === 1 ? 'copy' : 'copies'}`;
  if (copies <= 0) return { name, copies, words: 'asleep · picks it up when it wakes', seconds: null, gap: false };
  const rolling = copies > p ? `${batch(p)} at a time` : null;
  const how = startFirst
    ? [rolling, 'starts new before stopping old'].filter(Boolean).join(' · ')
    : (rolling ?? (copies === 1 ? 'a short gap while it restarts' : 'all at once · a short gap'));
  return { name, copies, words: `${n} · ${how}`, seconds: s ? rolloutSeconds(s, copies) : null, gap: !startFirst && copies <= p };
}

/** "~40 s · no downtime" · "~25 s · checkout has a short gap" — only what the specs say. */
export function restartSummary(lines: readonly RestartLine[]): string | null {
  if (lines.length === 0) return null;
  const known = lines.map((l) => l.seconds).filter((x): x is number => x !== null);
  const time = known.length === lines.length && known.length ? `~${Math.max(...known)} s` : null;
  const gaps = lines.filter((l) => l.gap).map((l) => l.name);
  const down = gaps.length === 0 ? 'no downtime' : `${gaps.join(', ')} ${gaps.length === 1 ? 'has' : 'have'} a short gap`;
  return [time, down].filter(Boolean).join(' · ');
}
