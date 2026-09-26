import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NodeSummary, TrafficNowView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { buildRows, type BoardRow } from './app-board-model';
import { useAppPlacement } from './use-app-placement';
import { useApps, type AppsState } from './use-apps';

export interface AppsBoard extends AppsState {
  rows: BoardRow[];
  nodes: NodeSummary[] | undefined;
  traffic: TrafficNowView | undefined;
}

/**
 * Everything the Apps list shows, from existing queries: the live inventory
 * (`useApps`, the one source for app words), releases, git environments and
 * previews, placement, open incidents, the health narrative and traffic.
 * A column whose query hasn't answered yet stays a skeleton (undefined).
 */
export function useAppsBoard(): AppsBoard {
  const trpc = useTRPC();
  const a = useApps();
  const placement = useAppPlacement(a.inventory);
  const releases = useQuery({ ...trpc.releases.list.queryOptions({ limit: 100 }), refetchInterval: 15_000 });
  const gitApps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 30_000 });
  const incidents = useQuery({ ...trpc.incidents.list.queryOptions({ status: 'open', limit: 50 }), refetchInterval: 30_000 });
  const health = useQuery({ ...trpc.observability.health.queryOptions({}), refetchInterval: 30_000 });
  const traffic = useQuery({ ...trpc.traffic.now.queryOptions(), refetchInterval: 30_000 });

  const rows = React.useMemo(
    () =>
      buildRows({
        apps: a.apps,
        gitApps: gitApps.data,
        releases: releases.data,
        placement: placement.byApp,
        incidents: incidents.data,
        health: health.data?.entries,
      }),
    [a.apps, gitApps.data, releases.data, placement.byApp, incidents.data, health.data],
  );

  return { ...a, rows, nodes: placement.nodes, traffic: traffic.data };
}
