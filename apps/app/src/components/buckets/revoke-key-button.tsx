import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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

/** Revoke one key's access to this bucket (`buckets.grantKeyOnBucket` deny all), confirmed. */
export function RevokeKeyButton({
  bucket,
  accessKeyId,
  name,
  usedBy,
}: {
  bucket: BucketDetailView;
  accessKeyId: string;
  name: string;
  /** "storefront / api" when an attached app runs on this key. */
  usedBy?: string;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const revoke = useMutation(
    trpc.buckets.grantKeyOnBucket.mutationOptions({
      onSuccess: () => {
        toast.success(`${name || accessKeyId} can no longer reach ${bucket.name}`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={revoke.isPending}>
          Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {name || accessKeyId}?</AlertDialogTitle>
          <AlertDialogDescription>
            It loses read, write and owner access to {bucket.name} at once.
            {usedBy ? ` ${usedBy} runs on this key and stops reaching its files; detaching the app is the cleaner way.` : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep access</AlertDialogCancel>
          <AlertDialogAction
            onClick={() =>
              revoke.mutate({ bucketId: bucket.id, accessKeyId, permissions: { read: true, write: true, owner: true }, mode: 'deny' })
            }
          >
            Revoke access
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
