import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { NextAction } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { relativeTime } from './backup-format';

/** The failed save is the one next action: run it again, same volume, same destination. */
export function RetryBackupAction({
  snap,
}: {
  snap: { volume: string; targetId: string; startedAt: string; error?: string | null };
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const run = useMutation(
    trpc.backups.backupVolume.mutationOptions({
      onSuccess: () => {
        toast.success(`${snap.volume} saved`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(`Backup of ${snap.volume} failed again`, { description: e.message }),
    }),
  );
  return (
    <NextAction
      tone="bad"
      title={`${snap.volume} didn’t save ${relativeTime(snap.startedAt)}`}
      tech={snap.error ?? undefined}
      actions={
        <Button disabled={run.isPending} onClick={() => run.mutate({ volume: snap.volume, targetId: snap.targetId })}>
          {run.isPending ? 'Saving…' : 'Back it up again'}
        </Button>
      }
    >
      Runs the same save to the same place now. It doesn’t stop the app.
    </NextAction>
  );
}
