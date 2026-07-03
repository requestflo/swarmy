import * as React from 'react';
import { ShieldIcon } from 'lucide-react';
import { relativeTime, untilTime } from './backup-format';

interface StackDrHeroProps {
  stack: string;
  lastBackupAt: string | null;
  nextRunAt: string | null;
  targetName: string | null;
  snapshotCount: number;
}

/** This stack's DR posture at a glance: last backup, next schedule, home. */
export function StackDrHero({
  stack,
  lastBackupAt,
  nextRunAt,
  targetName,
  snapshotCount,
}: StackDrHeroProps): React.JSX.Element {
  const covered = snapshotCount > 0;
  return (
    <div className="ink-block flex flex-wrap items-center justify-between gap-6 rounded-2xl px-6 py-6 sm:px-8">
      <div className="flex min-w-0 items-start gap-4">
        <span className="bg-ink-foreground/10 flex size-11 shrink-0 items-center justify-center rounded-2xl">
          <ShieldIcon className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-xl font-bold">
            {covered ? (
              <>
                {stack} is <em className="text-primary">covered</em>.
              </>
            ) : (
              <>
                {stack} has <em className="text-primary">no backups</em> yet.
              </>
            )}
          </h2>
          <p className="text-ink-foreground/70 mt-1 max-w-xl text-sm">
            {covered
              ? `${snapshotCount} snapshot${snapshotCount === 1 ? '' : 's'} in the catalog, encrypted and deduplicated.`
              : 'Add a schedule below and this stack starts backing itself up.'}
          </p>
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
