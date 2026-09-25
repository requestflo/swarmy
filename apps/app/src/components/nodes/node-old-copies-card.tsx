import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveIcon } from 'lucide-react';
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
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Old copies left on this server by a move. Kept for 7 days, then the owner is
 * asked — swarmy never deletes one on its own. Renders nothing when there are none.
 */
export function NodeOldCopiesCard({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const copies = useQuery({ ...trpc.decommission.oldCopies.queryOptions({ id: nodeId }), refetchInterval: 60_000 });
  const del = useMutation(
    trpc.decommission.deleteOldCopy.mutationOptions({
      onSuccess: () => {
        toast.success('Old copy deleted');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const list = copies.data ?? [];
  if (list.length === 0) return null;
  const due = list.filter((c) => c.due).length;

  return (
    <Card className="calm-card border-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ArchiveIcon className="text-primary size-4" />
          {due > 0 ? `${due} old cop${due === 1 ? 'y is' : 'ies are'} ready to delete` : 'Old copies kept after moves'}
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-border grid grid-cols-1 divide-y">
        {list.map((c) => (
          <div key={`${c.service}/${c.volume}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
            <span>
              <span className="mono-data">{c.volume}</span>{' '}
              <span className="text-muted-foreground">
                ({c.service}) moved off on {new Date(c.movedAt).toLocaleDateString()}
                {c.due ? '. Its app runs elsewhere and was checked; delete this copy?' : ` · kept until ${new Date(c.promptAt).toLocaleDateString()}`}
              </span>
            </span>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant={c.due ? 'destructive' : 'ghost'} disabled={del.isPending}>
                  Delete old copy
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete the old copy of {c.volume}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {c.service} already runs on another server with its own verified copy. This removes the copy left
                    on this server. It can't be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction onClick={() => del.mutate({ service: c.service, nodeId, volume: c.volume })}>
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
