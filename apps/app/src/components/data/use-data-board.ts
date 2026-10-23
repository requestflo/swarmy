import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { UNGROUPED } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { attachmentMap } from '@/components/buckets/attach-plan';
import { useBucketReach } from '@/components/buckets/use-bucket-reach';
import { buildClusters, servicesPerApp, SHARED } from './data-board-model';
import { useComposeStores } from './use-compose-stores';
import { useEstateData } from './use-estate-data';

const SYSTEM_STACK = 'swarmy-system';

/**
 * Everything the Data board draws: the estate's stores (plus compose
 * databases), one cluster per app, who can reach each bucket, and the live
 * services a dropped bucket would attach to.
 */
export function useDataBoard() {
  const trpc = useTRPC();
  const d = useEstateData();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 15_000 });
  const storage = useQuery(trpc.storage.status.queryOptions());

  const services = inventory.data?.services;
  const apps = React.useMemo(() => {
    const live = (inventory.data?.projects ?? []).map((p) => p.name).filter((n) => n !== UNGROUPED && n !== SYSTEM_STACK);
    return [...new Set([...live, ...d.apps.filter((a) => a !== SHARED)])].sort();
  }, [inventory.data, d.apps]);
  const compose = useComposeStores(apps);
  const items = React.useMemo(() => [...d.items, ...compose], [d.items, compose]);

  const buckets = d.bucketStore?.buckets ?? [];
  const reach = useBucketReach(buckets.map((b) => b.id));
  const counts = services ? servicesPerApp(services, [SYSTEM_STACK, UNGROUPED]) : undefined;
  const attachedTo = attachmentMap(d.bucketDetails);

  return {
    ...d,
    items,
    clusters: buildClusters(items, apps, counts),
    apps,
    services: services ?? [],
    servicesReady: services !== undefined,
    reach,
    attachedTo,
    /** How many servers keep the files (Garage members); undefined until it answers. */
    storeServers: storage.data?.members.length,
  };
}

export type DataBoard = ReturnType<typeof useDataBoard>;
