import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import {
  Button,
  type ButtonProps,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { AttachQueueFields, EMPTY_QUEUE_DRAFT, type QueueDraft } from './attach-queue-fields';

/**
 * Attach-queue wizard: pick the worker service + backing cache cluster, name
 * the queue and set the autoscale rules. Writes the `swarmy.queues` label.
 */
export function AttachQueueDialog({
  variant = 'default',
}: {
  variant?: ButtonProps['variant'];
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<QueueDraft>(EMPTY_QUEUE_DRAFT);

  const attach = useMutation(
    trpc.queues.attach.mutationOptions({
      onSuccess: (q) => {
        toast.success(`Queue ${q.name} attached to ${q.workerService}`);
        setOpen(false);
        setDraft(EMPTY_QUEUE_DRAFT);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const close = (next: boolean): void => {
    setOpen(next);
    if (!next) setDraft(EMPTY_QUEUE_DRAFT);
  };

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
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <PlusIcon className="size-4" /> Attach queue
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach a queue</DialogTitle>
          <DialogDescription>
            Tell swarmy which worker service consumes which queue on which cache — it will watch
            depths, autoscale the workers and surface failures.
          </DialogDescription>
        </DialogHeader>
        <AttachQueueFields draft={draft} onChange={setDraft} />
        <DialogFooter>
          <Button onClick={submit} disabled={!ready || attach.isPending}>
            {attach.isPending ? 'Attaching…' : 'Attach queue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
