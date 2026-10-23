import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { connectableApps, groupResources, linkAuditLine, type ManagedGroup } from './connections-model';
import type { StackEndpoints } from './types';

/**
 * Everything the Connections tab needs for one app, settled together: the
 * apps that can be connected, the app's internal names (`stacks.endpoints`),
 * the env var each managed resource's wiring set, and the newest link audit
 * row naming it.
 */
export function useConnections(app: string | undefined) {
  const trpc = useTRPC();
  const stacks = useQuery({ ...trpc.stacks.list.queryOptions(), refetchInterval: 15_000 });
  const apps = connectableApps(stacks.data ?? []);
  const current = app ?? apps[0];
  const stack = current ?? '';
  const on = !!current;
  const ep = useQuery({ ...trpc.stacks.endpoints.queryOptions({ stack }), enabled: on, refetchInterval: 10_000 });
  const audit = useQuery({ ...trpc.audit.list.queryOptions({ action: 'stack.link.', limit: 50 }), refetchInterval: 30_000 });
  const cache = useQuery({ ...trpc.cache.list.queryOptions({ stack }), enabled: on });
  const search = useQuery({ ...trpc.search.list.queryOptions({ stack }), enabled: on });
  const vector = useQuery({ ...trpc.vector.list.queryOptions({ stack }), enabled: on });

  const vars: Record<string, string[]> = {};
  const add = (key: string, envVars: string[]): void => {
    vars[key] = [...new Set([...(vars[key] ?? []), ...envVars])].sort();
  };
  for (const c of cache.data ?? []) add(`cache:${c.name}`, c.attachments.map((a) => a.envVar));
  for (const s of search.data ?? []) add(`search:${s.name}`, s.attachments.map((a) => a.envVar));
  for (const v of vector.data ?? []) add(`vector:${v.name}`, v.attachments.map((a) => a.envVar));

  const endpoints = ep.data as StackEndpoints | undefined;
  const groups: ManagedGroup[] = endpoints ? groupResources(endpoints.resources) : [];
  return {
    ready: stacks.isSuccess && (!on || ep.isSuccess),
    error: stacks.error ?? ep.error,
    retry: () => void Promise.all([stacks.refetch(), ep.refetch()]),
    apps,
    app: current,
    endpoints,
    groups,
    vars,
    auditLine: current && audit.data ? linkAuditLine(audit.data.entries, current) : null,
  };
}

export type ConnectionsData = ReturnType<typeof useConnections>;
