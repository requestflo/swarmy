import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EraserIcon, Trash2Icon } from 'lucide-react';
import type { ConfigFamilyView } from '@swarmy/core';
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

/**
 * Housekeeping: prune old detached versions (safe, no confirm) and delete the
 * whole family behind an AlertDialog (blocked server-side while consumed).
 */
export function ConfigDangerRow({ family }: { family: ConfigFamilyView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const prune = useMutation(
    trpc.configs.pruneVersions.mutationOptions({
      onSuccess: (r) => {
        toast.success(
          r.removedVersions.length > 0
            ? `Pruned v${r.removedVersions.join(', v')} of ${r.family}`
            : 'Nothing to prune — old versions are still in use.',
        );
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const del = useMutation(
    trpc.configs.deleteFamily.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Config ${r.family} deleted`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const oldVersions = family.versions.length - 1;
  const inUse = family.usedByCount > 0;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={oldVersions === 0 || prune.isPending}
          onClick={() => prune.mutate({ family: family.family })}
        >
          <EraserIcon className="size-3.5" />
          {prune.isPending ? 'Pruning…' : `Prune old versions (${oldVersions})`}
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="border-status-offline/40 text-status-offline hover:bg-status-offline/10"
              disabled={inUse || del.isPending}
            >
              <Trash2Icon className="size-3.5" />
              {del.isPending ? 'Deleting…' : 'Delete config'}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {family.family}?</AlertDialogTitle>
              <AlertDialogDescription>
                Removes every version ({family.versions.length}) from Docker. There is no undo —
                pruned versions cannot be rolled back to.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction onClick={() => del.mutate({ family: family.family })}>
                Delete every version
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <p className="text-muted-foreground text-xs">
        {inUse
          ? `Deletion is blocked while ${family.usedByCount} service(s) still use it — detach them first.`
          : 'Deleting removes every version from Docker. There is no undo.'}
      </p>
    </section>
  );
}
