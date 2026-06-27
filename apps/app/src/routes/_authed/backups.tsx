import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';
import { AddTargetDialog } from '@/components/backups/add-target-dialog';
import { BackupVolumeDialog } from '@/components/backups/backup-volume-dialog';
import { SnapshotsTable } from '@/components/backups/snapshots-table';

export const Route = createFileRoute('/_authed/backups')({
  component: BackupsPage,
});

function BackupsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const targets = useQuery(trpc.backups.listTargets.queryOptions());
  const snapshots = useQuery(trpc.backups.listSnapshots.queryOptions({}));

  const remove = useMutation(
    trpc.backups.removeTarget.mutationOptions({
      onSuccess: () => {
        toast.success('Target removed');
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const targetRows = targets.data ?? [];
  const snapCount = snapshots.data?.length ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Backups"
        title={
          snapCount > 0 ? (
            <>
              <CountUp value={snapCount} /> snapshot{snapCount === 1 ? '' : 's'} <em>safe</em>.
            </>
          ) : (
            <>
              Never lose <em>your</em> data.
            </>
          )
        }
        description="Encrypted, deduplicated restic snapshots of your volumes — to any S3 target. Restore to any node, any time."
        actions={
          <StatusBadge
            tone={targetRows.length > 0 ? 'online' : 'neutral'}
            label={targetRows.length > 0 ? `${targetRows.length} target${targetRows.length === 1 ? '' : 's'}` : 'No targets'}
          />
        }
      />

      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            Targets
            <div className="flex items-center gap-2">
              <BackupVolumeDialog targets={targetRows} />
              <AddTargetDialog />
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="border-t">
            {targetRows.map((t) => (
              <div
                key={t.id}
                className="hover:bg-accent/60 flex items-center justify-between gap-4 border-b px-6 py-3 transition-colors last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="font-medium">{t.name}</p>
                  <p className="text-muted-foreground mono-label truncate">
                    {t.kind} · {t.endpoint ? `${t.endpoint}/` : ''}
                    {t.bucket}
                    {t.prefix ? `/${t.prefix}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="muted">{t.hasCredentials ? 'keyed' : 'no creds'}</Badge>
                  <Button variant="ghost" size="icon" onClick={() => remove.mutate({ id: t.id })}>
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
            {targetRows.length === 0 && (
              <div className="text-muted-foreground px-6 py-12 text-center text-sm">
                No targets yet. Add an S3 bucket to start protecting your volumes.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="card-pop mt-6 border-0">
        <CardHeader>
          <CardTitle className="text-base">Snapshots</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <SnapshotsTable />
        </CardContent>
      </Card>
    </div>
  );
}
