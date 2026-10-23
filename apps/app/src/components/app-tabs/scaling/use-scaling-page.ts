import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NodeSummary, ServiceSummary } from '@swarmy/core';
import { useAppPlacement as useEstatePlacement } from '@/components/apps/use-app-placement';
import { useSettingsDraft, type SettingsDraftState } from '@/components/service-settings/use-settings-draft';
import { useTRPC } from '@/integrations/trpc';
import { useAppPlacement, type PlacedService } from './use-app-placement';
import { useScalingService, type ScalingServiceData } from './use-scaling-service';

export interface ScalingPage {
  rows: PlacedService[] | undefined;
  nodes: NodeSummary[] | undefined;
  /** The service the page is about (the picker); the first one until someone picks. */
  picked: PlacedService | undefined;
  pick: (id: string) => void;
  svc: ScalingServiceData;
  /** The size draft (CPU + memory limits) over the picked service's live spec. */
  draft: SettingsDraftState;
  /** server id → services with copies on it; undefined until every server answered. */
  servicesByNode: Map<string, ServiceSummary[]> | undefined;
}

/** Everything Config › Scaling reads, from queries that already exist (shared caches with Apps). */
export function useScalingPage(stack: string): ScalingPage {
  const trpc = useTRPC();
  const { rows, nodes } = useAppPlacement(stack);
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const { servicesByNode } = useEstatePlacement(inventory.data);
  const [pickedId, setPickedId] = React.useState<string | null>(null);
  const picked = rows?.find((r) => r.inv.id === pickedId) ?? rows?.[0];
  const svc = useScalingService(picked?.inv);
  const draft = useSettingsDraft(picked?.inv.id ?? '', svc.spec, picked?.inv.replicas.desired ?? 0);
  return { rows, nodes, picked, pick: setPickedId, svc, draft, servicesByNode };
}
