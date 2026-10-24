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
import { changeWords } from './cluster-config-words';

/** Confirm, then `swarmKv.revert`: the older version is written again as a new one, so it can be undone the same way. */
export function RevertConfigDialog({
  collection,
  id,
  label,
  seq,
  nextSeq,
  changes,
}: {
  collection: string;
  id: string;
  label: string;
  seq: number;
  nextSeq: number;
  changes: string[];
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const revert = useMutation(
    trpc.swarmKv.revert.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.changed ? `Put back v${r.restoredFrom} as v${r.seq}` : 'Nothing to change: it already matched');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" disabled={revert.isPending}>
          Put back v{seq}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Put back v{seq} of {label}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-2 text-sm">
              <p>
                swarmy saves v{seq}’s settings again as v{nextSeq}. The versions in between are kept, so you can undo this
                the same way. {changeWords(changes)}.
              </p>
              <p>What runs follows on the next pass of the part of swarmy that owns this setting.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep the current one</AlertDialogCancel>
          <AlertDialogAction onClick={() => revert.mutate({ collection, id, seq })}>Put back v{seq}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
