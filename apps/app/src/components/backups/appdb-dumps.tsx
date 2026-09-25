import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackupIcon } from 'lucide-react';
import { Badge, Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { fmtBytes, relativeTime } from './backup-format';
import { RestoreAppDbConfirm } from './restore-appdb-confirm';

interface AppDbDumpsProps {
  stack: string;
  service: string;
  engine: string;
}

const REASON_LABEL: Record<string, string> = {
  scheduled: 'nightly',
  manual: 'manual',
  'pre-restore': 'safety',
};

/**
 * A compose database's logical dumps (the restic catalog, newest first) with
 * "Back up now" and a Restore per dump. Rendered under its row on the stack
 * Backups tab's Databases card.
 */
export function AppDbDumps({ stack, service, engine }: AppDbDumpsProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const dumps = useQuery({ ...trpc.backups.appDb.list.queryOptions({ stack, service }), retry: false });
  const backupNow = useMutation(
    trpc.backups.appDb.backupNow.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Dumped ${service}`, {
          description: `${fmtBytes(r.sizeBytes)} with ${r.tool ?? r.engine}${r.databases.length ? ` · ${r.databases.join(', ')}` : ''}`,
        });
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(`Dump of ${service} failed`, { description: e.message, duration: 12_000 }),
    }),
  );
  const rows = (dumps.data ?? []).slice(0, 10);

  return (
    <div className="bg-accent/40 grid gap-2 rounded-xl px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="mono-label text-muted-foreground">Logical dumps</span>
        <Button
          size="sm"
          variant="outline"
          className="rounded-full"
          disabled={backupNow.isPending}
          onClick={() => backupNow.mutate({ stack, service })}
        >
          <DatabaseBackupIcon className="size-4" /> {backupNow.isPending ? 'Dumping…' : 'Back up now'}
        </Button>
      </div>
      {dumps.isLoading ? (
        <span className="shimmer-line block h-4 w-48 rounded" />
      ) : dumps.error ? (
        <p className="text-tone-bad text-sm">{dumps.error.message}</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No dumps yet — the first runs with tonight's backup.</p>
      ) : (
        <div className="divide-border divide-y">
          {rows.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-3 py-1.5">
              <span className="mono-data text-sm">{d.id.slice(0, 8)}</span>
              <span className="text-muted-foreground text-sm">{relativeTime(d.time)}</span>
              {d.reason && <Badge variant="muted">{REASON_LABEL[d.reason] ?? d.reason}</Badge>}
              <span className="ml-auto">
                <RestoreAppDbConfirm stack={stack} service={service} engine={engine} snapshotId={d.id} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
