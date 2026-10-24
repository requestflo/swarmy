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
import { abandonWords } from './pause-words';
import { STEP_TEXT, type PlatformRun } from './use-platform';

/** Abandon a paused upgrade: says exactly what goes back and what stays, then platform.abandon. */
export function AbandonDialog({ run }: { run: PlatformRun }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const abandon = useMutation(
    trpc.platform.abandon.mutationOptions({
      onSuccess: () => {
        toast.success('Putting things back');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const kept = run.abandon?.kept ?? [];
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" className="pointer-coarse:min-h-11" disabled={abandon.isPending}>
          Abandon…
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Abandon the upgrade to {run.toVersion}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-2 text-sm">
              <p>{abandonWords(run)}</p>
              {kept.length ? (
                <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
                  {kept.map((k) => (
                    <li key={k.key}>
                      <b>{STEP_TEXT[k.key]?.name ?? k.key}</b>: {k.why}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p>Apps keep serving while it goes back. If something won’t come back healthy, it stays paused and says why.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it paused</AlertDialogCancel>
          <AlertDialogAction onClick={() => abandon.mutate({ id: run.id })}>Abandon and put back</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
