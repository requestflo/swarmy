import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcwIcon, Trash2Icon, XCircleIcon } from 'lucide-react';
import type { QueueView } from '@swarmy/core';
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

/** Destructive action behind the one sanctioned modal — an AlertDialog confirm. */
function DestructiveButton({
  label,
  title,
  description,
  icon,
  pending,
  onConfirm,
}: {
  label: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  pending: boolean;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="text-status-offline border-status-offline/40 hover:bg-status-offline/10"
          disabled={pending}
        >
          {icon} {pending ? '…' : label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{label}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Queue actions: retry failed (BullMQ), drain, and remove the definition. */
export function QueueActions({
  queue,
  onRemoved,
}: {
  queue: QueueView;
  onRemoved: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const ref = { workerService: queue.workerService, queue: queue.name };
  const done = (msg: string): void => {
    toast.success(msg);
    void qc.invalidateQueries();
  };

  const retry = useMutation(
    trpc.queues.retryFailed.mutationOptions({
      onSuccess: (r) => done(`${r.moved} failed jobs back on the queue (${r.remaining} left)`),
      onError: (e) => toast.error(e.message),
    }),
  );
  const drain = useMutation(
    trpc.queues.drain.mutationOptions({
      onSuccess: (r) => done(`Drained ${r.removed} jobs from ${r.queue}`),
      onError: (e) => toast.error(e.message),
    }),
  );
  const remove = useMutation(
    trpc.queues.remove.mutationOptions({
      onSuccess: (r) => {
        done(`Queue ${r.queue} removed`);
        onRemoved();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <section className="space-y-2">
      <p className="mono-label text-muted-foreground !mb-0">Actions</p>
      <div className="flex flex-wrap items-center gap-2">
        {queue.convention === 'bullmq' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={retry.isPending || (queue.stats?.failed ?? 0) === 0}
            onClick={() => retry.mutate({ ...ref, limit: 100 })}
          >
            <RotateCcwIcon className="size-3.5" />
            {retry.isPending ? 'Retrying…' : 'Retry failed'}
          </Button>
        ) : null}
        <DestructiveButton
          label="Drain queue"
          title={`Drain ${queue.name}?`}
          description="Deletes every waiting and delayed job on this queue. Jobs already active or dead are untouched. This can't be undone."
          icon={<XCircleIcon className="size-3.5" />}
          pending={drain.isPending}
          onConfirm={() => drain.mutate(ref)}
        />
        <DestructiveButton
          label="Remove queue"
          title={`Remove ${queue.name}?`}
          description="Detaches the queue definition from this worker service. No job data is touched — you can re-attach it later."
          icon={<Trash2Icon className="size-3.5" />}
          pending={remove.isPending}
          onConfirm={() => remove.mutate(ref)}
        />
      </div>
      <p className="text-muted-foreground text-[11px]">
        Retry moves failed jobs back to waiting (batches of 100). Drain deletes waiting and delayed
        jobs. Remove only detaches the definition — no data is touched.
      </p>
    </section>
  );
}
