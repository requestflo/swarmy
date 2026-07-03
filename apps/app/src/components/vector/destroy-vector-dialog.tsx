import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import type { VectorInstanceView } from '@swarmy/core';
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

/** Destructive confirm (the one sanctioned modal): remove the qdrant service + key secret. */
export function DestroyVectorDialog({
  view,
  onDestroyed,
}: {
  view: VectorInstanceView;
  onDestroyed: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const attached = view.attachments.length;

  const destroy = useMutation(
    trpc.vector.destroy.mutationOptions({
      onSuccess: () => {
        toast.success(`Vector store ${view.name} removed`);
        onDestroyed();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" className="border-status-offline/40 text-status-offline">
          <Trash2Icon className="size-4" /> Destroy store
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Destroy {view.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Removes the qdrant service and the API-key secret. The data volume stays behind.
            {attached > 0
              ? ` ${attached} app(s) are still attached and will lose their vector store — they'll be detached by force.`
              : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={destroy.isPending}
            onClick={() =>
              destroy.mutate({ stack: view.stack, name: view.name, force: attached > 0 })
            }
          >
            {destroy.isPending ? 'Destroying…' : 'Destroy'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
