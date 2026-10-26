import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Undo from the server a move left (board 9), while it still can: puts the
 * service back here on this old copy (`decommission.undoMove`). A refusal
 * (something wrote to either copy since) comes back in swarmy's words.
 */
export function OldCopyUndo({ service, until }: { service: string; until: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const undo = useMutation(
    trpc.decommission.undoMove.mutationOptions({
      onSuccess: () => {
        toast.success(`Putting ${service} back here. It pauses briefly while swarmy checks nothing changed.`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const hours = Math.max(1, Math.round((Date.parse(until) - Date.now()) / 3_600_000));
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={undo.isPending}
      title={`Undo the move for about ${hours} more hour${hours === 1 ? '' : 's'}`}
      onClick={() => undo.mutate({ service })}
      className="pointer-coarse:min-h-11"
    >
      {undo.isPending ? 'Checking both copies…' : 'Undo the move'}
    </Button>
  );
}
