import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { useMove, type MoveRun } from './move-context';

/**
 * Undo a finished move (`decommission.undoMove`, admin only, like the move).
 * The call checks both copies first, so a refusal ("Writes happened on wkr-2
 * since the move; undoing would lose them.") comes back as the error, said
 * where the button was. On success the card follows the Undo like a move.
 */
export function useUndoMove(run: MoveRun): { undo: () => void; pending: boolean; refusal: string | null } {
  const trpc = useTRPC();
  const m = useMove();
  const mut = useMutation(trpc.decommission.undoMove.mutationOptions());
  const undo = React.useCallback(
    () =>
      mut.mutate(
        { service: run.chip.name },
        { onSuccess: () => m.started({ chip: run.chip, fromId: run.toId, toId: run.fromId, startedAt: Date.now(), undo: true }) },
      ),
    [mut, m, run],
  );
  return { undo, pending: mut.isPending, refusal: mut.error?.message ?? null };
}
