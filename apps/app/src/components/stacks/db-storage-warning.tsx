import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TriangleAlertIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

export interface DbStorageView {
  state: 'persistent' | 'unmounted' | 'unknown';
  message?: string;
}

/**
 * Legacy-storage banner on a managed-DB cluster row: the primary keeps its data
 * on an anonymous volume, so any restart starts it EMPTY. Offers the guarded
 * `db.migrateStorage` (pg_dump → online pg_basebackup → verify → redeploy
 * mounted + pinned; the primary is never stopped before the copy is verified).
 */
export function DbStorageWarning({
  stack,
  cluster,
  storage,
}: {
  stack: string;
  cluster: string;
  storage: DbStorageView;
}): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const migrate = useMutation(
    trpc.db.migrateStorage.mutationOptions({
      onSuccess: (res) => {
        toast.success(
          res.outcome === 'already'
            ? `${res.cluster} is already on persistent storage`
            : `${res.cluster} now stores data on ${res.dataVolume}`,
          res.backupScope ? { description: res.backupScope.note } : undefined,
        );
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (storage.state === 'persistent') return null;
  const unmounted = storage.state === 'unmounted';

  return (
    <div className="border-status-offline/40 bg-status-offline/10 text-status-offline mt-4 flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3 text-sm">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
        <span>{storage.message}</span>
      </div>
      {unmounted ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="outline" disabled={migrate.isPending}>
              {migrate.isPending ? 'Migrating…' : 'Migrate storage'}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Move {cluster} onto a persistent volume?</AlertDialogTitle>
              <AlertDialogDescription>
                swarmy takes a pg_dump backup of the app database first (other databases and
                roles are not in that dump), then copies the running primary into a named
                volume on the same node with pg_basebackup. The database is read-only while
                the copy runs, then restarts on the new volume: expect a short write outage.
                If anything fails before the restart, the primary is left running as it was.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => migrate.mutate({ stack, cluster })}>
                Back up and migrate
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
