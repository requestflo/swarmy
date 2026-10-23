import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Trash2Icon } from 'lucide-react';
import type { BucketDetailView } from '@swarmy/core';
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
import { deleteBlocked } from './bucket-facts';

/**
 * Delete bucket, confirmed. While it holds files or an app uses it the
 * button is off and says why — the server refuses the same cases.
 */
export function BucketDelete({ bucket: b }: { bucket: BucketDetailView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const del = useMutation(
    trpc.buckets.deleteBucket.mutationOptions({
      onSuccess: () => {
        toast.success(`${b.name} deleted`);
        void qc.invalidateQueries();
        void navigate({ to: '/data/buckets' });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const blocked = deleteBlocked(b);
  return (
    <div className="flex flex-wrap items-center gap-3 px-1">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="outline" size="sm" className="text-tone-bad" disabled={blocked !== null || del.isPending} aria-describedby="bucket-delete-why">
            <Trash2Icon className="size-4" /> Delete bucket
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {b.name}?</AlertDialogTitle>
            <AlertDialogDescription>It is empty and no app uses it. Deleting removes it from the store for good.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => del.mutate({ bucketId: b.id })}>Delete bucket</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <span id="bucket-delete-why" className="text-muted-foreground text-xs">
        {blocked ?? 'Empty and unused, so it can go.'}
      </span>
    </div>
  );
}
