import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ScheduledJobView } from '@swarmy/core';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Danger confirm: deletes the job AND its run history. */
export function DeleteJobDialog({
  job,
  onOpenChange,
}: {
  job: ScheduledJobView | null;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const remove = useMutation(
    trpc.jobs.remove.mutationOptions({
      onSuccess: () => {
        toast.success(`Job ${job?.name ?? ''} deleted`);
        void qc.invalidateQueries();
        onOpenChange(false);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={job !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {job?.name}?</DialogTitle>
          <DialogDescription>
            The schedule stops and its whole run history goes with it. This can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button
            variant="outline"
            className="border-status-offline text-status-offline hover:bg-status-offline/10"
            disabled={remove.isPending || !job}
            onClick={() => job && remove.mutate({ id: job.id })}
          >
            {remove.isPending ? 'Deleting…' : 'Delete job'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
