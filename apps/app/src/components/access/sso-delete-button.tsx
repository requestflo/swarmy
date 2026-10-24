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

/** Delete an SSO provider, behind a confirm (its sign-ins go with it). */
export function SsoDeleteButton({ id, providerId }: { id: string; providerId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const del = useMutation(
    trpc.sso.delete.mutationOptions({
      onSuccess: () => {
        toast.success('SSO provider deleted');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" className="text-status-offline" disabled={del.isPending}>
          <Trash2Icon className="size-4" /> Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete SSO provider "{providerId}"?</AlertDialogTitle>
          <AlertDialogDescription>
            Anyone signing in through this provider will be unable to. There is no undo.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={() => del.mutate({ id })}>Delete provider</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
