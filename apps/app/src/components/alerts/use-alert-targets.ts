import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { useServiceStackMap } from './use-service-stack-map';

export interface AlertTargetApp {
  name: string;
  /** Part names inside the app (the Docker service name without `<app>_`). */
  parts: string[];
}

export interface AlertTargetOptions {
  apps: AlertTargetApp[];
  servers: string[];
}

/** swarmy's own plumbing is not an app a person targets. */
const SYSTEM_STACK = 'swarmy-system';

/**
 * What a rule can be narrowed to: every app with its parts (stacks.list + the
 * live inventory's service → app map) and every server (nodes.list).
 */
export function useAlertTargets(): AlertTargetOptions {
  const trpc = useTRPC();
  const stacks = useQuery({ ...trpc.stacks.list.queryOptions(), refetchInterval: 60_000 });
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 60_000 });
  const serviceStack = useServiceStackMap();
  return React.useMemo(() => {
    const parts = new Map<string, Set<string>>();
    for (const [service, stack] of serviceStack) {
      const part = service.startsWith(`${stack}_`) ? service.slice(stack.length + 1) : service;
      parts.set(stack, (parts.get(stack) ?? new Set()).add(part));
    }
    const names = new Set([...(stacks.data ?? []).map((s) => s.name), ...parts.keys()]);
    names.delete(SYSTEM_STACK);
    return {
      apps: [...names].sort().map((name) => ({ name, parts: [...(parts.get(name) ?? [])].sort() })),
      servers: (nodes.data ?? []).map((n) => n.name).sort(),
    };
  }, [stacks.data, nodes.data, serviceStack]);
}
