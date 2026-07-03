import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { AttachQueueFields, EMPTY_QUEUE_DRAFT, type QueueDraft } from './attach-queue-fields';

/**
 * Attach-queue form, inline (a Collapsible parent supplies the expand/collapse
 * chrome — see `StackQueuesSection`). Writes the `swarmy.queues` label.
 */
export function AttachQueueInline({ onDone }: { onDone: () => void }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<QueueDraft>(EMPTY_QUEUE_DRAFT);

  const attach = useMutation(
    trpc.queues.attach.mutationOptions({
      onSuccess: (q) => {
        toast.success(`Queue ${q.name} attached to ${q.workerService}`);
        setDraft(EMPTY_QUEUE_DRAFT);
        void qc.invalidateQueries();
        onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const ready = Boolean(
    draft.workerService && draft.cacheCluster && draft.name.trim() && draft.minWorkers <= draft.maxWorkers,
  );

  const submit = (): void => {
    attach.mutate({
      workerService: draft.workerService,
      name: draft.name.trim(),
      cacheCluster: draft.cacheCluster,
      convention: draft.convention,
      ...(draft.convention === 'list' && draft.listKey.trim()
        ? { listKey: draft.listKey.trim() }
        : {}),
      scalePerJobs: draft.scalePerJobs,
      minWorkers: draft.minWorkers,
      maxWorkers: draft.maxWorkers,
      retries: draft.retries,
      dlq: draft.dlq,
    });
  };

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        Tell swarmy which worker service consumes which queue on which cache — it will watch
        depths, autoscale the workers and surface failures.
      </p>
      <AttachQueueFields draft={draft} onChange={setDraft} />
      <div className="flex justify-end">
        <Button onClick={submit} disabled={!ready || attach.isPending}>
          {attach.isPending ? 'Attaching…' : 'Attach queue'}
        </Button>
      </div>
    </div>
  );
}
