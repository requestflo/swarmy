import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { specFromInspect, type ServiceDetail, type ServiceUsageView } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { findStackApp, type StackAppMatch } from '@/components/gitops/gitops-types';
import { useTRPC } from '@/integrations/trpc';

export interface ServiceSettingsData {
  service: ServiceDetail | null | undefined;
  /** The full live spec (Docker truth, from `services.inspect`); null when unreadable. */
  spec: ServiceSpec | null | undefined;
  usage: ServiceUsageView | null | undefined;
  hosts: string[] | undefined;
  /** Latest scan of exactly this image ref, when there is one. */
  scan: { criticalCount: number; highCount: number; scannedAt: string } | null | undefined;
  /** The git app this part's app deploys from, when it is git-managed. */
  git: StackAppMatch | null | undefined;
  isPending: boolean;
}

/** Everything the settings panel reads, from the queries that already exist. */
export function useServiceSettings(serviceId: string): ServiceSettingsData {
  const trpc = useTRPC();
  const svc = useQuery({ ...trpc.services.get.queryOptions({ id: serviceId }), refetchInterval: 5_000 });
  const inspect = useQuery({ ...trpc.services.inspect.queryOptions({ id: serviceId }), refetchInterval: 15_000 });
  const usage = useQuery({ ...trpc.services.usage.queryOptions({ id: serviceId }), refetchInterval: 5_000 });
  const routes = useQuery(trpc.ingress.listServiceRoutes.queryOptions({ serviceId }));
  const image = svc.data?.image;
  const scans = useQuery({
    ...trpc.registryPolicy.listScans.queryOptions({ imageRef: image ?? '', limit: 1 }),
    enabled: !!image,
  });
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 30_000 });

  const networks = svc.data?.networks;
  const spec = React.useMemo(
    () => (inspect.data === undefined ? undefined : specFromInspect(inspect.data, networks ?? [])),
    [inspect.data, networks],
  );
  const stack = svc.data?.stackId;
  const scan = scans.data ? (scans.data[0] ?? null) : image ? undefined : null;
  return {
    service: svc.data,
    spec,
    usage: usage.isError ? null : usage.data,
    hosts: routes.data ? [...new Set(routes.data.map((r) => r.host))] : routes.isError ? [] : undefined,
    scan,
    git: apps.data ? (stack ? findStackApp(apps.data, stack) : null) : apps.isError ? null : undefined,
    isPending: svc.isPending,
  };
}
