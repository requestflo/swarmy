import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EraserIcon, Trash2Icon } from 'lucide-react';
import type { SecretFamilyView } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Housekeeping + danger zone: prune old detached versions (safe) and delete
 * the whole family (blocked server-side while anything still consumes it).
 */
export function FamilyDanger({
  family,
  onDeleted,
}: {
  family: SecretFamilyView;
  onDeleted: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);

  const prune = useMutation(
    trpc.secrets.pruneVersions.mutationOptions({
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
    trpc.secrets.deleteFamily.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Secret ${r.family} deleted`);
        onDeleted();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const oldVersions = family.versions.length - 1;
  const inUse = family.usedByCount > 0;

  return (
    <section className="space-y-2">
      <p className="mono-label text-muted-foreground !mb-0">Housekeeping</p>
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
        <Button
          size="sm"
          variant="outline"
          className="border-status-offline/40 text-status-offline hover:bg-status-offline/10"
          disabled={inUse || del.isPending}
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            del.mutate({ family: family.family });
          }}
        >
          <Trash2Icon className="size-3.5" />
          {del.isPending ? 'Deleting…' : confirming ? 'Click again to confirm' : 'Delete secret'}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {inUse
          ? `Deletion is blocked while ${family.usedByCount} service(s) still use it — detach them first.`
          : 'Deleting removes every version from Docker. There is no undo.'}
      </p>
    </section>
  );
}
