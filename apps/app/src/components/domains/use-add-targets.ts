import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { DomainPlan } from '@/components/ingress/domain-state';
import { isValidHost, normalizeHost } from './host-shape';

export interface Target {
  serviceId: string;
  stack: string;
  /** The service name without its `<stack>_` prefix. */
  name: string;
}

/** Every app service a domain can point at, as "app / service". */
export function useTargets(): { targets: Target[]; ready: boolean } {
  const trpc = useTRPC();
  const services = useQuery(trpc.services.list.queryOptions());
  const stacks = useQuery(trpc.stacks.list.queryOptions());
  const targets = React.useMemo(() => {
    const names = new Map((stacks.data ?? []).map((s) => [s.id, s.name] as const));
    return (services.data ?? [])
      .map((s) => {
        const stack = (s.stackId && (names.get(s.stackId) ?? s.stackId)) || '(ungrouped)';
        const name = s.name.startsWith(`${stack}_`) ? s.name.slice(stack.length + 1) : s.name;
        return { serviceId: s.id, stack, name };
      })
      .filter((t) => t.stack !== 'swarmy-system')
      .sort((a, b) => `${a.stack}/${a.name}`.localeCompare(`${b.stack}/${b.name}`));
  }, [services.data, stacks.data]);
  return { targets, ready: services.isSuccess && stacks.isSuccess };
}

/** The port the service listens on, from the live inventory (first HTTP-ish suggestion). */
export function useSuggestedPort(serviceId: string): number | null {
  const trpc = useTRPC();
  const ports = useQuery({ ...trpc.ingress.detectPorts.queryOptions({ serviceId }), enabled: serviceId !== '' });
  return ports.data?.[0]?.port ?? null;
}

/** The service's automatic address today (it keeps working alongside a new domain), and which services have one. */
export function useAutoAddress(serviceId: string): { autoAddress: string | null; routed: Set<string> } {
  const trpc = useTRPC();
  const domains = useQuery(trpc.ingress.listDomains.queryOptions());
  const routed = React.useMemo(() => new Set((domains.data ?? []).filter((d) => d.auto).map((d) => d.serviceId)), [domains.data]);
  return { autoAddress: domains.data?.find((d) => d.serviceId === serviceId && d.auto)?.host ?? null, routed };
}

/** The controller's record plan for the typed host (debounced; the last answer stays while typing). */
export function useDomainPlan(rawHost: string): { plan: DomainPlan | null; checking: boolean } {
  const trpc = useTRPC();
  const host = normalizeHost(rawHost);
  const [settled, setSettled] = React.useState(host);
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(host), 300);
    return () => clearTimeout(t);
  }, [host]);
  const q = useQuery({
    ...trpc.ingress.domainPlan.queryOptions({ host: settled }),
    enabled: isValidHost(settled),
    placeholderData: (prev) => prev,
  });
  const plan = isValidHost(host) ? ((q.data as DomainPlan | undefined) ?? null) : null;
  return { plan, checking: q.isFetching || settled !== host };
}
