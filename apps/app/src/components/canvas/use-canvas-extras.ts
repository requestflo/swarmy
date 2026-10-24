import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { InvService } from '@swarmy/core';
import type { StackEndpoints } from '@/components/connections/types';
import { useTRPC } from '@/integrations/trpc';
import { isManagedMember, type CanvasExtras } from './canvas-extras';
import { domainSpec, serviceMetrics } from './canvas-signals';
import { serviceSparks, sparkNames, SPARK_BUCKET_S, SPARK_WINDOW_MIN } from './canvas-sparks';
import { dataNodes, type DataLists } from './data-nodes';

export interface CanvasExtrasData {
  /** Null until the app's stores are known (`stacks.endpoints`): the canvas draws the plain inventory meanwhile. */
  extras: CanvasExtras | null;
  endpoints: StackEndpoints | undefined;
  /** Every list the data nodes read, for connect targets beyond the canvas (other buckets). */
  lists: DataLists;
}

/**
 * The reads behind the canvas's data nodes, front door and per-part numbers:
 * the app's stores and their wiring (`stacks.endpoints`, Docker truth), each
 * store's own list for its size and health, the service map's RED rows
 * (`observability.map`, empty while telemetry is off), each part's last hour
 * in one batched query (`observability.requestSeriesMany`, the sparklines)
 * and visits at the edge (`traffic.now`). Each fills in when it lands.
 */
export function useCanvasExtras(stack: string, services: readonly InvService[]): CanvasExtrasData {
  const trpc = useTRPC();
  const ep = useQuery({ ...trpc.stacks.endpoints.queryOptions({ stack }), refetchInterval: 10_000 });
  const db = useQuery({ ...trpc.db.get.queryOptions({ stack }), refetchInterval: 15_000 });
  const cache = useQuery({ ...trpc.cache.list.queryOptions({ stack }), refetchInterval: 15_000 });
  const search = useQuery({ ...trpc.search.list.queryOptions({ stack }), refetchInterval: 15_000 });
  const vector = useQuery({ ...trpc.vector.list.queryOptions({ stack }), refetchInterval: 15_000 });
  const buckets = useQuery({ ...trpc.buckets.overview.queryOptions(), refetchInterval: 30_000 });
  const map = useQuery({ ...trpc.observability.map.queryOptions({ windowMinutes: 15 }), refetchInterval: 15_000 });
  const traffic = useQuery({ ...trpc.traffic.now.queryOptions(), refetchInterval: 15_000 });
  const domains = useQuery({ ...trpc.ingress.listDomains.queryOptions({ stack }), refetchInterval: 15_000 });
  // Managed-store members draw as data nodes, not parts: no sparkline to ask for.
  const names = React.useMemo(() => sparkNames(stack, services.filter((s) => !isManagedMember(s))), [stack, services]);
  const series = useQuery({
    ...trpc.observability.requestSeriesMany.queryOptions({ stack, services: names, windowMinutes: SPARK_WINDOW_MIN, bucketSeconds: SPARK_BUCKET_S }),
    enabled: names.length > 0,
    refetchInterval: 60_000,
  });

  const lists: DataLists = React.useMemo(
    () => ({
      db: db.data?.clusters,
      cache: cache.data,
      search: search.data,
      vector: vector.data,
      buckets: buckets.data?.state === 'ready' ? buckets.data : undefined,
    }),
    [db.data, cache.data, search.data, vector.data, buckets.data],
  );
  const endpoints = ep.data as StackEndpoints | undefined;

  const extras = React.useMemo((): CanvasExtras | null => {
    if (!endpoints) return null;
    const rows = map.data?.status === 'ok' ? map.data.nodes : [];
    return {
      stack,
      data: dataNodes(endpoints, lists),
      domain: domains.data ? domainSpec(domains.data, traffic.data?.apps.find((a) => a.app === stack)) : null,
      metrics: serviceMetrics(stack, services, rows),
      sparks: series.data?.status === 'ok' ? serviceSparks(stack, services, series.data.series, series.dataUpdatedAt || Date.now()) : new Map(),
    };
  }, [endpoints, lists, map.data, domains.data, traffic.data, series.data, series.dataUpdatedAt, services, stack]);

  return { extras, endpoints, lists };
}
