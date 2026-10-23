import type { DbBackupSnapshotView, IncidentView, ReleaseView } from '@swarmy/core';
import { releaseLabel } from '@/components/app-tabs/releases/release-label';
import { backupRuns, type SnapshotLike } from '@/components/estate-map/rewind-ticks';

/**
 * Time travel's timeline, pure: one app's last 7 days of deploys
 * (`releases.list`), incidents (`incidents.list`, already scoped to the app)
 * and backups (volume runs from `backups.listSnapshots`, database saves from
 * `dbBackups.list`), each at its share of the week. Which events sit at the
 * head, and where ←/→ step to, are read off the same list.
 */

export const HOUR_MS = 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * HOUR_MS;
/** The head counts as "now" within this of the present. */
export const NOW_MS = 60 * 1000;

export type TravelKind = 'deploy' | 'incident' | 'backup';

export interface TravelEvent {
  id: string;
  kind: TravelKind;
  at: number;
  /** 0 (7 days ago) … 1 (now). */
  pos: number;
  /** Plain words for the lane button and its label. */
  title: string;
  /** A backup run where something failed. */
  failed?: boolean;
}

export interface TravelInput {
  releases?: ReleaseView[];
  incidents?: IncidentView[];
  snapshots?: SnapshotLike[];
  dbBackups?: DbBackupSnapshotView[];
  now: number;
}

const DEPLOY_WORD: Record<ReleaseView['status'], string> = {
  deploying: 'is rolling out',
  healthy: 'went out',
  superseded: 'went out',
  'rolled-back': 'went out, then was put back',
  failed: 'failed its health check',
};

export function travelEvents(input: TravelInput): TravelEvent[] {
  const from = input.now - WEEK_MS;
  const pos = (t: number): number => Math.min(1, Math.max(0, (t - from) / WEEK_MS));
  const within = (iso: string): number | null => {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= from && t <= input.now ? t : null;
  };
  const out: TravelEvent[] = [];
  for (const r of input.releases ?? []) {
    const t = within(r.createdAt);
    if (t !== null) out.push({ id: `deploy-${r.id}`, kind: 'deploy', at: t, pos: pos(t), title: `${releaseLabel(r)} ${DEPLOY_WORD[r.status]}` });
  }
  for (const i of input.incidents ?? []) {
    const t = within(i.openedAt);
    if (t !== null) out.push({ id: `incident-${i.id}`, kind: 'incident', at: t, pos: pos(t), title: i.title });
  }
  for (const run of backupRuns(input.snapshots ?? [], from, input.now)) {
    const failed = run.snaps.filter((s) => s.status === 'FAILED').length;
    const running = run.snaps.some((s) => s.status === 'RUNNING');
    const n = run.snaps.length;
    const what = n === 1 ? run.snaps[0]!.volume.replace(/^[^_]+_/, '') : `${n} volumes`;
    const title = failed
      ? failed === n ? `Backing up ${what} failed` : `${n - failed} of ${n} volumes saved`
      : running ? `Backing up ${what}` : `Backed up ${what}`;
    out.push({ id: `backup-${run.snaps[0]!.id}`, kind: 'backup', at: run.at, pos: pos(run.at), title, ...(failed ? { failed: true } : {}) });
  }
  for (const b of input.dbBackups ?? []) {
    const t = within(b.time);
    if (t !== null) out.push({ id: `save-${b.id}`, kind: 'backup', at: t, pos: pos(t), title: 'Saved the database' });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The events the head is on: within `slack` ms of T (callers widen it to a few pixels of the bar). */
export function eventsAt(events: TravelEvent[], t: number, slack = 2 * 60 * 1000): TravelEvent[] {
  return events.filter((e) => Math.abs(e.at - t) <= slack);
}

/**
 * ←/→: the next event after T (or now, past the last one), or the last one
 * before it (T stays put before the first).
 */
export function stepTo(events: TravelEvent[], t: number, dir: 1 | -1, now: number): number {
  if (dir === 1) return events.find((e) => e.at > t + 1)?.at ?? now;
  return [...events].reverse().find((e) => e.at < t - 1)?.at ?? t;
}

/** Events closer than `gap` (a share of the week) share one lane button. */
export function groupEvents(events: TravelEvent[], gap: number): TravelEvent[][] {
  const out: TravelEvent[][] = [];
  for (const e of events) {
    const last = out.at(-1);
    if (last && e.pos - last[0]!.pos < gap) last.push(e);
    else out.push([e]);
  }
  return out;
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n: number): string => String(n).padStart(2, '0');

/** "Tue 22 · 14:20" in the viewer's time zone. */
export function momentLabel(t: number): string {
  const d = new Date(t);
  return `${DAY[d.getDay()]} ${d.getDate()} · ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** "14:20". */
export function clockLabel(t: number): string {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** "2 d 3 h ago" · "40 min ago" · "now". */
export function agoLabel(t: number, now: number): string {
  const mins = Math.round((now - t) / 60_000);
  if (mins < 1) return 'now';
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  if (d) return `${d} d ${h} h ago`;
  return h ? `${h} h ${mins % 60} min ago` : `${mins} min ago`;
}

/** The local midnights inside the week, as axis labels: "Fri 18" at its share of the bar. */
export function dayMarks(now: number): { label: string; pos: number }[] {
  const from = now - WEEK_MS;
  const d = new Date(from);
  d.setHours(24, 0, 0, 0);
  const out: { label: string; pos: number }[] = [];
  for (; d.getTime() <= now; d.setDate(d.getDate() + 1)) {
    out.push({ label: `${DAY[d.getDay()]} ${d.getDate()}`, pos: (d.getTime() - from) / WEEK_MS });
  }
  return out;
}
