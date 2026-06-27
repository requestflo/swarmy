import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlayIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * The page's single coral CTA: kick off a controller backup now. Disabled until
 * a restore passphrase is captured and a target is picked — the two
 * preconditions surfaced on the schedule card.
 */
export function BackupNowButton(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const config = useQuery(trpc.controllerBackup.getConfig.queryOptions());

  const runNow = useMutation(
    trpc.controllerBackup.runNow.mutationOptions({
      onSuccess: () => {
        toast.success('Controller backup started');
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const canRun = Boolean(config.data?.targetId) && (config.data?.hasPassphrase ?? false);

  return (
    <Button onClick={() => runNow.mutate()} disabled={!canRun || runNow.isPending}>
      <PlayIcon className="size-4" /> Back up now
    </Button>
  );
}
