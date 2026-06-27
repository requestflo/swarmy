import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { DatabaseBackupIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusBadge,
  type StatusTone,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';

const TONE: Record<string, StatusTone> = {
  SUCCEEDED: 'online',
  RUNNING: 'progress',
  FAILED: 'offline',
  PRUNED: 'neutral',
};

function fmtSize(bytes: unknown): string {
  if (!bytes) return '—';
  return `${(Number(bytes) / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Controller-state restore catalog — flat hairline rows inside one card-pop.
 * Status comes straight off the cluster tokens via StatusBadge.
 */
export function SnapshotsList(): React.JSX.Element {
  const trpc = useTRPC();
  const snapshots = useQuery(trpc.controllerBackup.listSnapshots.queryOptions());
  const rows = snapshots.data ?? [];

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Snapshots</CardTitle>
        <CardDescription>
          Controller-state restore catalog. For total-loss recovery, use the standalone{' '}
          <code className="mono-data">bun run restore</code> CLI with your passphrase.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyState
              className="border-0"
              icon={<DatabaseBackupIcon />}
              title="No controller backups yet."
              description="Set a passphrase, pick a target, and back up now — restore points show up here the moment they finish."
            />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_auto] gap-x-4 px-6 pb-2 sm:grid-cols-[1.4fr_auto_1fr_0.8fr]">
              <span className="mono-label">Taken</span>
              <span className="mono-label hidden text-right sm:block">Size</span>
              <span className="mono-label hidden sm:block">restic id</span>
              <span className="mono-label hidden text-right sm:block">DB mode</span>
            </div>
            <div className="border-t">
              {rows.map((s) => {
                const tone = TONE[s.status] ?? 'neutral';
                return (
                  <div
                    key={s.id}
                    className="hover:bg-accent/60 grid grid-cols-[1fr_auto] items-center gap-x-4 border-b px-6 py-3 transition-colors last:border-b-0 sm:grid-cols-[1.4fr_auto_1fr_0.8fr]"
                  >
                    <div className="min-w-0">
                      <p className="mono-data truncate text-sm">{relTime(s.startedAt)}</p>
                      <StatusBadge tone={tone} label={s.status.toLowerCase()} />
                    </div>
                    <span className="mono-data hidden text-right text-xs sm:block">
                      {fmtSize(s.sizeBytes)}
                    </span>
                    <span className="mono-data text-muted-foreground hidden truncate text-xs sm:block">
                      {s.resticSnapshotId ?? '—'}
                    </span>
                    <span className="mono-data text-muted-foreground hidden text-right text-xs sm:block">
                      {s.manifest?.dbDriver ?? '—'}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
