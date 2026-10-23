import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { PlacedService } from '../scaling/use-app-placement';
import { durableName, withDurable, type VolumeRow } from './volume-model';

/**
 * "Make durable" (board AppPlacement) asked once, in a sentence: the
 * anonymous volume gets a name, so a restarted copy finds its files again.
 * services.update replaces the mount list, so every other mount is sent as
 * it is.
 */
export function MakeDurable({ stack, row, svc, onDone }: { stack: string; row: VolumeRow; svc: PlacedService; onDone: () => void }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const name = durableName(stack, row.part, row.target);
  const save = useMutation(
    trpc.services.update.mutationOptions({
      onSuccess: () => {
        toast.success(`${row.part} keeps ${row.target} in ${name} now`);
        onDone();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const many = svc.inv.replicas.desired > 1;
  return (
    <div role="status" className="bg-surface-2 dark:bg-accent/50 my-2 flex flex-col gap-2 rounded-xl px-3.5 py-2.5">
      <p className="text-[13.5px]">
        Keep {row.part}’s {row.target} in a named volume? It survives restarts on the same server
        {many ? `; each of its ${svc.inv.replicas.desired} copies keeps its own` : ''}. A copy that moves to another server still starts empty. {row.part} restarts once to pick it up.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={save.isPending || !svc.detail}
          className="pointer-coarse:min-h-11"
          onClick={() => svc.detail && save.mutate({ id: svc.inv.id, volumes: withDurable(svc.detail.volumes, row.target, name) })}
        >
          {save.isPending ? 'Saving…' : 'Make durable'}
        </Button>
        <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <Tech>
        services.update volumes · {name}:{row.target}
      </Tech>
    </div>
  );
}
