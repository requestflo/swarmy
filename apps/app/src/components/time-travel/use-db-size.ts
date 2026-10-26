import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { sizeSeries, type SizeSeries } from './time-travel-sizes';
import type { AppDatabase } from './use-time-travel';

/**
 * The app's database size over the week, from its backup records: the wal-g
 * base backups' data sizes (`dbBackups.pitrWindow`, read from the WAL repo
 * by its agent; asked only for a wal-g point-in-time cluster) or else the
 * sizes of its saves (`dbBackups.list`, already on the page).
 */
export function useDbSize(stack: string, db: AppDatabase | undefined, now: number): SizeSeries | null {
  const trpc = useTRPC();
  const walg = Boolean(db?.row.pitr && db.row.engine === 'wal-g');
  const window = useQuery({
    ...trpc.dbBackups.pitrWindow.queryOptions({ stack, cluster: db?.row.cluster ?? '' }),
    enabled: walg,
    staleTime: 5 * 60_000,
  });
  const backups = walg ? window.data?.backups : undefined;
  return React.useMemo(
    () => (db ? sizeSeries({ cluster: db.row.cluster, saves: db.saves, baseBackups: backups, now }) : null),
    [db, backups, now],
  );
}
