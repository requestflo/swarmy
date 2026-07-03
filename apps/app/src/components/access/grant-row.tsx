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
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { GrantEntry } from './access-shared';

/** One resource-grant row; removal is destructive (revokes access) so it's an AlertDialog. */
export function GrantRow({ grant }: { grant: GrantEntry }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const del = useMutation(
    trpc.members.deleteGrant.mutationOptions({
      onSuccess: () => {
        toast.success('Grant removed');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="hover:bg-accent/60 grid grid-cols-[1.5fr_auto] items-center gap-x-4 px-6 py-4 transition-colors sm:grid-cols-[2fr_1fr_2fr_auto]">
      <div className="min-w-0">
        <p className="mono-data truncate text-xs">
          {grant.principalType}:{grant.principalId}
        </p>
        <p className="text-muted-foreground mono-label truncate sm:hidden">
          {grant.relation} · {grant.resourceType}:{grant.resourceId}
        </p>
      </div>
      <span className="hidden sm:block">
        <StatusBadge tone="online" label={grant.relation} />
      </span>
      <span className="mono-data hidden truncate text-xs sm:block">
        {grant.resourceType}:{grant.resourceId}
      </span>
      <div className="flex justify-end">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" disabled={del.isPending}>
              <Trash2Icon className="size-4" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove this grant?</AlertDialogTitle>
              <AlertDialogDescription>
                {grant.principalType}:{grant.principalId} loses {grant.relation} on{' '}
                {grant.resourceType}:{grant.resourceId} immediately.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction onClick={() => del.mutate({ id: grant.id })}>
                Remove grant
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
