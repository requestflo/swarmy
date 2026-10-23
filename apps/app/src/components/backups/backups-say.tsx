import * as React from 'react';
import { Say } from '@/components/calm';
import { TextSkeleton } from '@/components/states';
import { relativeTime } from './backup-format';
import type { RestoreGridData } from './use-restore-grid';

/**
 * The /backups sentence. It counts what the restore-point grid counts (each
 * volume, database and swarmy itself, by its newest attempt last night), so
 * the header and the dots never disagree; until every list has answered the
 * number is a skeleton, never a guess.
 */
export function backupsTitle(
  hasTargets: boolean,
  grid: RestoreGridData,
  lastSavedAt: string | null,
  points: number,
): React.ReactNode {
  if (!hasTargets) return <>Backups have nowhere to go yet. <Say tone="warn">Give them a home.</Say></>;
  if (!grid.settled) return <>Saved last night: <TextSkeleton className="h-7 w-24" /></>;
  const { saved, total } = grid.lastNight;
  if (total > saved) {
    return <>{saved} of {total} saved last night. <Say tone="bad">{total - saved} didn’t.</Say></>;
  }
  const tail = `${points} restore points${lastSavedAt ? `, the last ${relativeTime(lastSavedAt)}` : ''}.`;
  if (total) return <>All {total} saved last night. <em>{tail}</em></>;
  return <>Everything is saved nightly. <em>{tail}</em></>;
}
