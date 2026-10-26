import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { writesWords } from './time-travel-writes';

interface RowsSinceProps {
  stack: string;
  cluster: string;
  /** The save's id as `dbBackups.list` shows it (restic's short id). */
  saveId: string;
}

/**
 * "~12k rows changed since this save": Postgres's own write count, kept on
 * the save when it was taken and read again now (`dbBackups.writes`). Says
 * nothing for a save that didn't record it, and says when a restart made
 * the count start again. Read once, not polled: each read is an audited
 * studio read.
 */
export function RowsSince({ stack, cluster, saveId }: RowsSinceProps): React.JSX.Element | null {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.dbBackups.writes.queryOptions({ stack, cluster }), staleTime: 5 * 60_000, refetchOnWindowFocus: false });
  const v = q.data;
  const since = v?.saves.find((s) => s.snapshotId === saveId.slice(0, 8))?.since;
  if (!v?.read || !since) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <p className={cn('text-[12.5px]', since.status === 'counted' && since.rows > 0 ? 'text-foreground' : 'text-muted-foreground')}>{writesWords(since)}</p>
      <Tech>
        pg_stat_user_tables n_tup_ins + n_tup_upd + n_tup_del · {v.database ?? 'its database'} · approximate · counting since {v.countingSince}
      </Tech>
    </div>
  );
}
