import { useQuery } from '@tanstack/react-query';
import type { DbBackupOverviewRow } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { pickPitrWindow } from './pitr-scrub';

/**
 * A wal-g PITR cluster's window and WAL check: the agent's read of the WAL
 * repo (`dbBackups.pitrWindow`, a sidecar run, so read sparingly) and
 * `dbBackups.walCheck` for a gap. Restoring from the second copy (`copyId`)
 * reads the copy's own window; until that read lands, the estimate ends
 * where the copy restores to. The WAL check is the main archive's only.
 */
export function usePgWindow(stack: string, cluster: string, walg: boolean, row: DbBackupOverviewRow | null, copyId: string | null) {
  const trpc = useTRPC();
  const slow = { staleTime: 60_000, refetchInterval: 5 * 60_000, retry: false } as const;
  const read = useQuery({ ...trpc.dbBackups.pitrWindow.queryOptions({ stack, cluster, ...(copyId ? { targetId: copyId } : {}) }), enabled: walg, ...slow });
  const wal = useQuery({ ...trpc.dbBackups.walCheck.queryOptions({ stack, cluster }), enabled: walg && !copyId, ...slow });
  const reach = row?.copy?.restoresTo;
  const estimate = !copyId ? row : reach && row?.pitrWindow ? { pitrWindow: { from: row.pitrWindow.from, to: reach }, pitrWindowSource: 'estimate' as const } : null;
  const pitr = pickPitrWindow(walg ? read.data : null, estimate);
  return {
    window: pitr.window,
    source: pitr.source,
    unsupported: walg && read.data?.source === 'unsupported',
    walCheck: walg && !copyId ? (wal.data ?? null) : null,
  };
}
