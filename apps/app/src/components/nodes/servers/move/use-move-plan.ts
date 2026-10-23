import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { FleetView } from '../fleet/fleet-model';
import type { FleetServer } from '../use-fleet';
import { fitCheck, needFromUsage, roomiest, type Fit, type MemoryNow } from './fit-check';
import type { MoveDraft } from './move-context';
import { subjectBlock, targetBlock, volumesFromInspect } from './move-rules';

export interface TargetPlan {
  id: string;
  name: string;
  block: string | null;
  fit: Fit;
}

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

/** A server's memory now: the live sample, else the summary's percent of its size. */
export function memoryNow(s: FleetServer): MemoryNow | null {
  if (s.live?.memTotalBytes) return { usedBytes: s.live.memUsedBytes, totalBytes: s.live.memTotalBytes };
  const total = s.node.resources.memBytes;
  if (!total || !s.node.live) return null;
  return { usedBytes: (s.node.live.memPercent / 100) * total, totalBytes: total };
}

/**
 * The plan for placing `draft`: its volumes from the live spec
 * (`services.inspect`), its memory now (`services.usage`), and for every
 * other server whether it can take it and how it would fit.
 */
export function useMovePlan(draft: MoveDraft | null, servers: FleetView[], admin: boolean): MovePlan | null {
  const trpc = useTRPC();
  const id = draft?.chip.id ?? '';
  const inspect = useQuery({ ...trpc.services.inspect.queryOptions({ id }), enabled: !!draft, staleTime: 30_000 });
  const usage = useQuery({ ...trpc.services.usage.queryOptions({ id }), enabled: !!draft, refetchInterval: 10_000 });

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
    const from = servers.find((s) => s.server.node.id === draft.fromId);
    const source = from ? memoryNow(from.server) : null;
    const targets = servers
      .filter((s) => s.server.node.id !== draft.fromId)
      .map((s): TargetPlan => {
        const n = s.server.node;
        return { id: n.id, name: n.name, block: targetBlock(draft.fromId, n), fit: fitCheck({ needBytes, dest: memoryNow(s.server), source }) };
      });
    return {
      block,
      checking: inspect.isPending,
      volumes,
      needBytes,
      copies,
      targets,
      best: roomiest(targets.filter((t) => !t.block)),
    };
  }, [draft, servers, admin, inspect.data, inspect.isError, inspect.isPending, usage.data]);
}
