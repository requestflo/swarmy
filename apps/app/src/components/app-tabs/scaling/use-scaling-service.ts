import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { specFromInspect, type InvService, type ServiceUsageView } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { useTRPC } from '@/integrations/trpc';

export interface ScalingServiceData {
  /** The live spec (limits); null when unreadable, undefined while it loads. */
  spec: ServiceSpec | null | undefined;
  /** What the copies use now (the busiest); null until one reports. */
  usage: ServiceUsageView | null | undefined;
  /** The first address that reaches it; null = none. */
  address: string | null | undefined;
}

/** The picked service's spec, usage and address — the queries the settings panel already reads. */
export function useScalingService(inv: InvService | undefined): ScalingServiceData {
  const trpc = useTRPC();
  const id = inv?.id ?? '';
  const on = !!inv;
  const inspect = useQuery({ ...trpc.services.inspect.queryOptions({ id }), enabled: on, refetchInterval: 15_000 });
  const usage = useQuery({ ...trpc.services.usage.queryOptions({ id }), enabled: on, refetchInterval: 5_000 });
  const routes = useQuery({ ...trpc.ingress.listServiceRoutes.queryOptions({ serviceId: id }), enabled: on });
  const networks = inv?.networks;
  const spec = React.useMemo(() => {
    if (inspect.isError) return null;
    if (inspect.data === undefined) return undefined;
    return specFromInspect(inspect.data, (networks ?? []).map((n) => n.name));
  }, [inspect.data, inspect.isError, networks]);
  return {
    spec,
    usage: usage.isError ? null : usage.data,
    address: routes.isError ? null : routes.data ? (routes.data[0]?.host ?? null) : undefined,
  };
}
