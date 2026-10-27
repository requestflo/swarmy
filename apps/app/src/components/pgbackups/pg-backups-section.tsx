import * as React from 'react';
import { CheckIcon } from 'lucide-react';
import { CardSkeleton, ErrorState } from '@/components/states';
import { isPhysical } from '@/components/stacks/db-backup-format';
import { PgLabelsCode, PgSavedCard } from './pg-backups-aside';
import { PgRestore } from './pg-restore';
import { PgRetention } from './pg-retention';
import { PgSummaryCards } from './pg-summary-cards';
import { usePgBackups, type PgSource } from './use-pg-backups';

interface PgBackupsProps {
  stack: string;
  cluster: string;
}

/**
 * One managed Postgres cluster's backups (board 40): the schedule, where it
 * goes and the last drill; the restore points across the keep window; and
 * restore, to any second when the cluster archives its changes.
 */
export function PgBackupsSection({ stack, cluster, primary }: PgBackupsProps & { primary: boolean }): React.JSX.Element {
  // Restores read from the main destination, or from the second copy when it is down.
  const [from, setFrom] = React.useState<PgSource>('main');
  const b = usePgBackups(stack, cluster, from);
  const [selected, setSelected] = React.useState<string | null>(null);
  if (b.pending) return <CardSkeleton lines={4} />;
  if (b.error) return <ErrorState title={`Couldn’t load ${cluster}’s backups.`} error={b.error} />;
  const logical = b.schedule != null && !isPhysical(b.schedule.engine);
  return (
    <div id={`pg-${cluster}`} className="flex scroll-mt-20 flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 pt-2">
        <h2 className="font-display text-[19px] font-bold tracking-[-0.01em]">{cluster}</h2>
        <span className="text-muted-foreground font-mono text-[11.5px]">postgres · database backups</span>
        {logical ? (
          <span className="text-muted-foreground flex items-center gap-1.5 text-[12.5px] sm:ml-auto">
            <CheckIcon aria-hidden className="text-tone-ok size-3.5" />
            Already on · encrypted and deduplicated
          </span>
        ) : null}
      </div>
      <PgSummaryCards stack={stack} cluster={cluster} b={b} />
      <PgRetention stack={stack} cluster={cluster} b={b} selected={selected} onSelect={setSelected} />
      <PgRestore stack={stack} cluster={cluster} b={b} selected={selected} primary={primary} onFrom={setFrom} />
    </div>
  );
}

/** The cluster's aside: its labels at Code, then what gets saved. */
export function PgBackupsAside({ stack, cluster }: PgBackupsProps): React.JSX.Element | null {
  const b = usePgBackups(stack, cluster);
  if (b.pending || b.error) return null;
  return (
    <>
      <PgLabelsCode stack={stack} cluster={cluster} b={b} />
      <PgSavedCard stack={stack} cluster={cluster} b={b} />
    </>
  );
}
