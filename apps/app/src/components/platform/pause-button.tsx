import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PauseIcon, PlayIcon } from 'lucide-react';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { PlatformRun } from './use-platform';

/**
 * "Pause after this step" on a running upgrade (design board: Upgrade.html);
 * once asked, "Keep going" takes it back. The request is saved on the run, so
 * it holds while swarmy restarts itself.
 */
export function PauseButton({ run }: { run: PlatformRun }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const pause = useMutation(
    trpc.platform.pause.mutationOptions({
      onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.platform.status.queryKey() }),
      onError: (e) => toast.error(e.message),
    }),
  );
  const asked = Boolean(run.pause);
  return (
    <Button
      variant="outline"
      className="pointer-coarse:min-h-11"
      disabled={pause.isPending}
      onClick={() => pause.mutate({ id: run.id, pause: !asked })}
    >
      {asked ? <PlayIcon className="size-3.5" aria-hidden /> : <PauseIcon className="size-3.5" aria-hidden />}
      {asked ? 'Keep going' : 'Pause after this step'}
    </Button>
  );
}
