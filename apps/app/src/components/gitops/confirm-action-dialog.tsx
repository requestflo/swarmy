import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import type { PlanActionView } from './gitops-types';
import { destroysWhat } from './plan-status';

interface ConfirmActionDialogProps {
  planId: string;
  action: PlanActionView;
}

/** The one coral button in the Plan drawer: confirm a held step, after saying what it destroys. */
export function ConfirmActionDialog({
  planId,
  action,
}: ConfirmActionDialogProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const confirm = useMutation(
    trpc.apps.confirm.mutationOptions({
      onSuccess: () => {
        toast.success('Confirmed. Rolling it out.');
        void qc.invalidateQueries({ queryKey: trpc.apps.pathKey() });
      },
      // FORBIDDEN arrives with a plain-words reason ("only owners can delete data").
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" disabled={confirm.isPending}>
          {confirm.isPending ? 'Confirming…' : 'Confirm'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{action.reason}?</AlertDialogTitle>
          <AlertDialogDescription>{destroysWhat(action)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <AlertDialogAction onClick={() => confirm.mutate({ planId, actionIds: [action.id] })}>
            Yes, go ahead
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
