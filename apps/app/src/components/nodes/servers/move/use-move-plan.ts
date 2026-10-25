import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { FleetView } from '../fleet/fleet-model';
import { needFromUsage, roomiest } from './fit-check';
import type { MoveDraft } from './move-context';
import { subjectBlock, volumesFromInspect } from './move-rules';
import { planTargets, roomFor, type TargetPlan } from './move-targets';

export { memoryNow, type TargetPlan } from './move-targets';

export interface MovePlan {
  /** Why it can't move at all (null = it can, as far as swarmy can tell). */
  block: string | null;
  /** Still reading the service's spec (its volumes). */
  checking: boolean;
  volumes: string[] | undefined;
  needBytes: number | null;
  copies: number;
  targets: TargetPlan[];
  best: TargetPlan | null;
}

/**
 * The plan for placing `draft`: its volumes from the live spec
 * (`services.inspect`), its memory now (`services.usage`), each server's
 * volume sizes (`nodes.volumeSizes`), and for every other server whether it
 * can take it and how it would fit (memory and disk).
 */
export function useMovePlan(draft: MoveDraft | null, servers: FleetView[], admin: boolean): MovePlan | null {
  const trpc = useTRPC();
  const id = draft?.chip.id ?? '';
  const inspect = useQuery({ ...trpc.services.inspect.queryOptions({ id }), enabled: !!draft, staleTime: 30_000 });
  const usage = useQuery({ ...trpc.services.usage.queryOptions({ id }), enabled: !!draft, refetchInterval: 10_000 });
  const sizes = useQuery({ ...trpc.nodes.volumeSizes.queryOptions(), enabled: !!draft, refetchInterval: 60_000 });

  return React.useMemo(() => {
    if (!draft) return null;
    const inv = draft.chip.inv;
    const volumes = inspect.data ? volumesFromInspect(inspect.data) : undefined;
    const copies = Math.max(1, inv?.replicas.desired ?? 1);
    const block =
      subjectBlock(
        { short: draft.chip.short, system: draft.chip.system, mode: inv?.mode ?? 'replicated', desired: copies, labels: inv?.labels ?? {}, volumes },
        admin,
      ) ?? (inspect.isError ? `swarmy couldn’t read ${draft.chip.short}’s settings just now, so it can’t tell what data to move.` : null);
    const needBytes = needFromUsage(usage.data, copies);
    // Sizes still loading: wait (no disk line yet); failed: unknown, which only warns.
    const known = sizes.isPending ? undefined : volumes;
    const targets = planTargets({ fromId: draft.fromId, servers, needBytes, volumes: known, sizes: sizes.data });
    return { block, checking: inspect.isPending, volumes, needBytes, copies, targets, best: roomiest(targets.filter(roomFor)) };
  }, [draft, servers, admin, inspect.data, inspect.isError, inspect.isPending, usage.data, sizes.data, sizes.isPending]);
}
