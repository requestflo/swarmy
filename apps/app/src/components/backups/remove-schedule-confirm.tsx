import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
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

interface RemoveScheduleConfirmProps {
  id: string;
  volume: string;
}

/** Destructive confirm for deleting a backup schedule. */
export function RemoveScheduleConfirm({ id, volume }: RemoveScheduleConfirmProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const remove = useMutation(
    trpc.schedules.remove.mutationOptions({
      onSuccess: () => {
        toast.success('Schedule removed');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove schedule for ${volume}`}
          className="text-status-offline hover:text-status-offline"
        >
          <Trash2Icon className="size-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop backing up {volume}?</AlertDialogTitle>
          <AlertDialogDescription>
            The schedule is deleted and no new snapshots are taken. Existing snapshots stay in the
            destination.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={remove.isPending} onClick={() => remove.mutate({ id })}>
            Remove schedule
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
