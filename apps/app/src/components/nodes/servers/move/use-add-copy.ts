import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { CopyAnswer } from './copy-words';
import { useMove, type MoveDraft } from './move-context';

/**
 * ⌥-drag (board 9): the controller's answer for one more copy of `draft` on
 * `toId` (`services.copyPlan`, read-only), and adding it (`services.addCopy`,
 * `service.scale`-gated; it re-checks, so a stale answer can't skip a refusal).
 */
export function useAddCopy(draft: MoveDraft, toId: string): {
  answer: CopyAnswer | undefined;
  failed: string | null;
  add: () => void;
  pending: boolean;
} {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const m = useMove();
  const q = useQuery({ ...trpc.services.copyPlan.queryOptions({ id: draft.chip.id, toNodeId: toId }), staleTime: 15_000, retry: false });
  const mut = useMutation(
    trpc.services.addCopy.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${draft.chip.short} now runs ${r.replicas} copies; the new one starts on ${r.to}.`);
        m.cancel();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const add = React.useCallback(() => mut.mutate({ id: draft.chip.id, toNodeId: toId }), [mut, draft.chip.id, toId]);
  return { answer: q.data, failed: q.error?.message ?? null, add, pending: mut.isPending };
}
