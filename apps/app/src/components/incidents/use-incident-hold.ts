import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { clockWords } from '@/components/apps/app-board-words';

export interface IncidentHold {
  busy: boolean;
  /** Take it (or keep it 30 more min); `takeOver` takes it from whoever has it. */
  take: (takeOver?: boolean) => void;
  /** Let go of it (the owner only). */
  release: () => void;
}

/**
 * "Take it for 30 min": `incidents.take` / `incidents.release` with the
 * toasts that say what changed. Each one lands on the incident's timeline.
 */
export function useIncidentHold(incidentId: string): IncidentHold {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const settle = { onSettled: () => void qc.invalidateQueries(), onError: (e: { message: string }) => void toast.error(e.message) };
  const take = useMutation(
    trpc.incidents.take.mutationOptions({
      ...settle,
      onSuccess: (d) => {
        if (d.owner) toast.success(`It’s yours until ${clockWords(d.owner.until)}. It goes back to nobody after that.`);
      },
    }),
  );
  const release = useMutation(
    trpc.incidents.release.mutationOptions({ ...settle, onSuccess: () => void toast.success('You let it go. Anyone can take it now.') }),
  );
  return {
    busy: take.isPending || release.isPending,
    take: (takeOver = false) => take.mutate({ id: incidentId, takeOver }),
    release: () => release.mutate({ id: incidentId }),
  };
}
