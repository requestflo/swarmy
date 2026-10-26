/**
 * Plain words for a restore's steps on the restore card
 * (`dbBackups.restoreProgress`): what each step does, the numbers the agent
 * reported for the one running now, and the real tool at Controls.
 */
import type { DbRestoreProgressView, DbRestoreStage } from '@swarmy/core';
import { fmtBytes } from '@/components/backups/backup-format';
import { formatPit } from './pitr-scrub';

const WORDS: Record<DbRestoreStage, (into: string) => string> = {
  create: (into) => `Creating ${into}`,
  safety: () => 'Saving what is there now',
  stop: (into) => `Stopping ${into}`,
  download: () => 'Downloading the save',
  base: () => 'Fetching the base copy',
  wal: () => 'Fetching the changes made since',
  load: (into) => `Loading it into ${into}`,
  start: (into) => `Starting ${into}`,
  replay: () => 'Replaying the changes',
  check: () => 'Checking it answers',
};

const TECH: Record<DbRestoreStage, string> = {
  create: 'db.provision · single · wired into no app',
  safety: 'db.backup · reason:pre-restore',
  stop: 'service.scale 0',
  download: 'restic restore',
  base: 'wal-g backup-fetch',
  wal: 'wal-g wal-fetch',
  load: 'pg_restore / psql',
  start: 'service.scale',
  replay: 'pg_last_xact_replay_timestamp()',
  check: 'SELECT 1 with the cluster’s own password',
};

/** The cluster part of `<stack>/<cluster>`. */
const short = (ref: string): string => ref.split('/').pop() ?? ref;

export function stepWords(stage: DbRestoreStage, v: Pick<DbRestoreProgressView, 'into'>): string {
  return WORDS[stage](short(v.into));
}

export function stepTech(stage: DbRestoreStage): string {
  return TECH[stage];
}

const time = (iso: string): string => formatPit(Date.parse(iso)).split(' · ')[1] ?? iso;

/** The numbers for the step running now, or null when there are none yet. */
export function stepDetail(v: DbRestoreProgressView): string | null {
  const stage = v.current?.stage;
  if (!stage) return null;
  if (stage === 'replay') {
    if (!v.replayedTo) return v.targetTime ? `to ${time(v.targetTime)} UTC` : null;
    return `up to ${time(v.replayedTo)}${v.targetTime ? ` of ${time(v.targetTime)}` : ''} UTC`;
  }
  if (stage === 'wal' && v.segments != null) return `${v.segments} segment${v.segments === 1 ? '' : 's'}`;
  if (v.bytesDone == null) return null;
  const of = v.bytesTotal ? ` of ${fmtBytes(v.bytesTotal)}` : '';
  const pct = v.percent != null ? v.percent : v.bytesTotal ? Math.min(100, (v.bytesDone / v.bytesTotal) * 100) : null;
  return `${fmtBytes(v.bytesDone)}${of}${pct != null ? ` · ${Math.floor(pct)}%` : ''}`;
}

/** The heading over the steps. */
export function runTitle(v: DbRestoreProgressView): string {
  const into = short(v.into);
  if (v.status === 'failed') return `The restore into ${into} stopped`;
  if (v.status === 'succeeded') return `Restored ${into}`;
  return v.mode === 'pitr' && v.targetTime ? `Restoring ${into} to ${formatPit(Date.parse(v.targetTime))} UTC` : `Restoring ${into}`;
}
