import { useQueries, useQuery } from '@tanstack/react-query';
import { specFromInspect } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { restartLine, restartSummary, type RestartLine } from './restart-words';

export interface RestartPlan {
  lines: RestartLine[];
  /** "~40 s · no downtime"; null when there's nothing to restart. */
  summary: string | null;
}

/**
 * How the given services pick up a change, from each one's live spec
 * (`services.inspect`) and its copies (`inventory.get`). Undefined until both
 * have landed; `enabled` lets a dialog read only while it's open.
 */
export function useRestartPlan(
  services: ReadonlyArray<{ id: string; name: string }>,
  enabled = true,
): RestartPlan | undefined {
  const trpc = useTRPC();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), enabled, refetchInterval: 4_000 });
  const specs = useQueries({
    queries: services.map((s) => ({ ...trpc.services.inspect.queryOptions({ id: s.id }), enabled, staleTime: 30_000 })),
  });
  if (!inventory.data || specs.some((q) => q.isPending)) return undefined;
  const live = inventory.data.services;
  const lines = services.map((s, i) => {
    const inv = live.find((x) => x.id === s.id);
    const data = specs[i]?.data;
    const spec = data ? specFromInspect(data, inv?.networks.map((n) => n.name) ?? []) : null;
    return restartLine(s.name, inv?.replicas.desired ?? 0, spec);
  });
  return { lines, summary: restartSummary(lines) };
}
