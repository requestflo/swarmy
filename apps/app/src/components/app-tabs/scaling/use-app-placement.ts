import { useQueries, useQuery } from '@tanstack/react-query';
import type { InvService, NodeSummary, ServiceDetail } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { useStackServices } from '../use-stack-services';

export interface PlacedService {
  inv: InvService;
  /** The spec (constraints, pinned server); undefined while it loads. */
  detail: ServiceDetail | null | undefined;
}

/** Each service of the app with its spec, plus the servers, for "where it runs". */
export function useAppPlacement(stack: string): {
  rows: PlacedService[] | undefined;
  nodes: NodeSummary[] | undefined;
} {
  const trpc = useTRPC();
  const { services } = useStackServices(stack);
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 15_000 });
  const details = useQueries({
    queries: (services ?? []).map((s) => ({ ...trpc.services.get.queryOptions({ id: s.id }), refetchInterval: 10_000 })),
  });
  const rows = services?.map((inv, i) => ({ inv, detail: details[i]?.data }));
  return { rows, nodes: nodes.data };
}
