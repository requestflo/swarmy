import type { IncidentView, ReleaseView } from '@swarmy/core';
import { releaseLabel } from '@/components/app-tabs/releases/release-label';

/**
 * Rewind's ticks, pure: the last 24 hours of deploys (`releases.list`),
 * backups (`backups.listSnapshots`, one tick per run window) and incidents
 * (`incidents.list`), each at its fraction of the day with the words and the
 * link its popover shows. It says what happened; it does not replay the map.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Snapshots that start within this window of each other are one backup run. */
const RUN_MS = 20 * 60 * 1000;

export type TickKind = 'deploy' | 'backup' | 'incident';

export interface RewindTick {
  id: string;
  kind: TickKind;
  at: number;
  /** 0 (24 h ago) … 1 (now). */
  pos: number;
  title: string;
  detail: string;
  link: { to: string; params?: Record<string, string>; label: string };
}

export interface SnapshotLike {
  id: string;
  volume: string;
  status: string;
  startedAt: string;
}

export interface RewindInput {
  releases?: ReleaseView[];
  snapshots?: SnapshotLike[];
  incidents?: IncidentView[];
  now: number;
}

const clock = (t: number): string => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const DEPLOY_WORD: Record<string, string> = {
  deploying: 'rolling out',
  healthy: 'went out healthy',
  'rolled-back': 'was put back',
  failed: 'failed',
  superseded: 'went out',
};

/** Group a day's snapshots into runs: "Backed up 14 volumes" (and how many failed). */
export function backupRuns(snaps: SnapshotLike[], from: number, to: number): { at: number; snaps: SnapshotLike[] }[] {
  const inDay = snaps
    .map((s) => ({ s, t: new Date(s.startedAt).getTime() }))
    .filter(({ t }) => Number.isFinite(t) && t >= from && t <= to)
    .sort((a, b) => a.t - b.t);
  const runs: { at: number; snaps: SnapshotLike[] }[] = [];
  for (const { s, t } of inDay) {
    const last = runs.at(-1);
    if (last && t - last.at <= RUN_MS) last.snaps.push(s);
    else runs.push({ at: t, snaps: [s] });
  }
  return runs;
}

export function rewindTicks(input: RewindInput): RewindTick[] {
  const from = input.now - DAY_MS;
  const pos = (t: number): number => Math.min(1, Math.max(0, (t - from) / DAY_MS));
  const within = (iso: string): number | null => {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= from && t <= input.now ? t : null;
  };
  const out: RewindTick[] = [];

  for (const r of input.releases ?? []) {
    const t = within(r.createdAt);
    if (t === null) continue;
    out.push({
      id: `deploy-${r.id}`,
      kind: 'deploy',
      at: t,
      pos: pos(t),
      title: `${r.stackName} ${releaseLabel(r)} ${DEPLOY_WORD[r.status] ?? 'went out'}`,
      detail: `Deploy at ${clock(t)}`,
      link: { to: '/stacks/$name/releases', params: { name: r.stackName }, label: 'Open releases' },
    });
  }

  for (const run of backupRuns(input.snapshots ?? [], from, input.now)) {
    const failed = run.snaps.filter((s) => s.status === 'FAILED').length;
    const n = run.snaps.length;
    out.push({
      id: `backup-${run.snaps[0]!.id}`,
      kind: 'backup',
      at: run.at,
      pos: pos(run.at),
      title: failed ? `${n - failed} of ${n} saved, ${failed} failed` : `Backed up ${n === 1 ? run.snaps[0]!.volume : `${n} volumes`}`,
      detail: `Backup at ${clock(run.at)}`,
      link: { to: '/backups', label: 'Open backups' },
    });
  }

  for (const i of input.incidents ?? []) {
    const t = within(i.openedAt);
    if (t === null) continue;
    out.push({
      id: `incident-${i.id}`,
      kind: 'incident',
      at: t,
      pos: pos(t),
      title: i.title,
      detail: `Incident opened at ${clock(t)}${i.status === 'resolved' ? ', now resolved' : ''}`,
      link: { to: '/incidents/$incidentId', params: { incidentId: i.id }, label: 'Open incident' },
    });
  }

  return out.sort((a, b) => a.at - b.at);
}

/** The axis words under the bar: "yesterday 10:42" … "now". */
export function rewindStart(now: number): string {
  return `yesterday ${clock(now - DAY_MS)}`;
}

export interface TickGroup {
  id: string;
  /** Where the group sits: its first tick's position. */
  pos: number;
  ticks: RewindTick[];
}

/**
 * Ticks closer than `gap` (a share of the day) share one button, so every
 * target stays 24px wide and none sits on top of another; the popover lists
 * each thing that happened in that stretch.
 */
export function groupTicks(ticks: RewindTick[], gap = 0.025): TickGroup[] {
  const out: TickGroup[] = [];
  for (const t of [...ticks].sort((a, b) => a.pos - b.pos)) {
    const last = out.at(-1);
    if (last && t.pos - last.pos < gap) last.ticks.push(t);
    else out.push({ id: t.id, pos: t.pos, ticks: [t] });
  }
  return out;
}
