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

/** Delete, confirmed. The server refuses while the bucket holds files or is attached. */
export function BucketDelete({ bucketId, name, onDeleted }: { bucketId: string; name: string; onDeleted: () => void }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const del = useMutation(
    trpc.buckets.deleteBucket.mutationOptions({
      onSuccess: () => {
        toast.success('Bucket deleted');
        onDeleted();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-muted-foreground text-xs">Delete is refused while the bucket holds files or an app uses it.</p>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="outline" className="text-tone-bad shrink-0" disabled={del.isPending}>
            <Trash2Icon className="size-4" /> Delete bucket
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete bucket "{name}"?</AlertDialogTitle>
            <AlertDialogDescription>Permanently removes the bucket from the store. There is no undo.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => del.mutate({ bucketId })}>Delete bucket</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
