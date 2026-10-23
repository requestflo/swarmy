import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Inventory, MoveStep } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { useMove, type MoveDraft } from './move-context';
import { movePhase, moveStep, type MovePhase } from './move-rules';

/** Start a move (`decommission.moveService`: admin only; it runs in the background). */
export function useStartMove(): { start: (d: MoveDraft, toId: string) => void; pending: boolean } {
  const trpc = useTRPC();
  const m = useMove();
  const mut = useMutation(trpc.decommission.moveService.mutationOptions({ onError: (e) => toast.error(e.message) }));
  const start = React.useCallback(
    (d: MoveDraft, toId: string) =>
      mut.mutate({ service: d.chip.name, toNodeId: toId }, { onSuccess: () => m.started({ ...d, toId, startedAt: Date.now() }) }),
    [mut, m],
  );
  return { start, pending: mut.isPending };
}

/**
 * Where the running move stands: the service's `swarmy.move.state` label in
 * the live inventory while it runs, then whether it now runs on the new
 * server (`services.list({ nodeId })`, read again after the label clears).
 */
export function useMoveProgress(inventory: Inventory | undefined): { phase: MovePhase; step: MoveStep | null } | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { run } = useMove();
  const live = run !== null;
  const onTo = useQuery({
    ...trpc.services.list.queryOptions({ nodeId: run?.toId ?? '' }),
    enabled: live,
    refetchInterval: (q) => (live && q.state.data?.some((s) => s.id === run?.chip.id) ? false : 3_000),
  });
  const step = run ? moveStep(inventory?.services.find((s) => s.id === run.chip.id)?.labels) : null;
  const seen = React.useRef<{ id: number; saw: boolean; clearedAt: number }>({ id: 0, saw: false, clearedAt: 0 });
  if (run && seen.current.id !== run.startedAt) seen.current = { id: run.startedAt, saw: false, clearedAt: 0 };
  if (step) seen.current.saw = true;
  else if (seen.current.saw && !seen.current.clearedAt) seen.current.clearedAt = Date.now();

  const phase = run
    ? movePhase({
        step,
        sawLabel: seen.current.saw,
        onTo: !!onTo.data?.some((s) => s.id === run.chip.id),
        fresh: seen.current.clearedAt > 0 && onTo.dataUpdatedAt > seen.current.clearedAt,
        elapsedMs: Date.now() - run.startedAt,
      })
    : null;

  const settled = phase === 'done' || phase === 'rolled-back' || phase === 'not-started';
  React.useEffect(() => {
    if (settled) void qc.invalidateQueries();
  }, [settled, qc]);
  return run && phase ? { phase, step } : null;
}
