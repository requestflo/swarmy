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

interface RemoveTargetConfirmProps {
  id: string;
  name: string;
}

/** Destructive confirm for deleting a backup destination. */
export function RemoveTargetConfirm({ id, name }: RemoveTargetConfirmProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const remove = useMutation(
    trpc.backups.removeTarget.mutationOptions({
      onSuccess: () => {
        toast.success('Destination removed');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Remove ${name}`}>
          <Trash2Icon className="size-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Schedules pointing here stop working and its snapshots disappear from the catalog. The
            restic repository itself is not deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={remove.isPending} onClick={() => remove.mutate({ id })}>
            Remove destination
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
