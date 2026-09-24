import * as React from 'react';
import { ShieldIcon } from 'lucide-react';
import { relativeTime, untilTime } from './backup-format';

interface StackDrHeroProps {
  stack: string;
  lastBackupAt: string | null;
  nextRunAt: string | null;
  targetName: string | null;
  snapshotCount: number;
  /** Schedules that will actually run (not paused). */
  activeScheduleCount: number;
}

interface Posture {
  lead: string;
  em: string;
  detail: string;
}

/**
 * The one truthful sentence about this stack's DR posture. "Covered" means a
 * schedule will run again — snapshots alone are history, not protection, so
 * a stack with old snapshots and nothing scheduled is told so.
 */
function posture({ stack, snapshotCount, activeScheduleCount, nextRunAt }: StackDrHeroProps): Posture {
  const snaps = `${snapshotCount} snapshot${snapshotCount === 1 ? '' : 's'} in the catalog, encrypted and deduplicated.`;
  if (activeScheduleCount > 0) {
    return {
      lead: `${stack} is`,
      em: 'covered',
      detail: `${nextRunAt ? `Next run ${untilTime(nextRunAt)}.` : 'A schedule is active.'} ${snapshotCount > 0 ? snaps : 'The first snapshot lands then.'}`,
    };
  }
  if (snapshotCount > 0) {
    return {
      lead: `${stack} has backups, but`,
      em: 'nothing scheduled',
      detail: `${snaps} Add a schedule below so the next one happens without you.`,
    };
  }
  return {
    lead: `${stack} has`,
    em: 'no backups',
    detail: 'Add a schedule below and this stack starts backing itself up.',
  };
}

/** This stack's DR posture at a glance: last backup, next schedule, home. */
export function StackDrHero(props: StackDrHeroProps): React.JSX.Element {
  const { lastBackupAt, nextRunAt, targetName } = props;
  const p = posture(props);
  return (
    <div className="ink-block flex flex-wrap items-center justify-between gap-6 rounded-2xl px-6 py-6 sm:px-8">
      <div className="flex min-w-0 items-start gap-4">
        <span className="bg-ink-foreground/10 flex size-11 shrink-0 items-center justify-center rounded-2xl">
          <ShieldIcon className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-xl font-bold">
            {p.lead} <em className="text-primary">{p.em}</em>.
          </h2>
          <p className="text-ink-foreground/70 mt-1 max-w-xl text-sm">{p.detail}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-6 sm:gap-8">
        <Stat label="Last backup" value={relativeTime(lastBackupAt)} />
        <Stat label="Next schedule" value={untilTime(nextRunAt)} />
        <Stat label="Destination" value={targetName ?? 'none'} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <p className="mono-data truncate text-lg font-bold">{value}</p>
      <p className="text-ink-foreground/60 mono-label">{label}</p>
    </div>
  );
}
