import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { UNGROUPED } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

/**
 * Docker service name → stack name, derived client-side from the live
 * inventory. Powers stack chips on incident rows whose title references a
 * service (`Service <name> disruption`) — no backend stack-scoping needed.
 */
export function useServiceStackMap(): Map<string, string> {
  const trpc = useTRPC();
  const inventory = useQuery({
    ...trpc.inventory.get.queryOptions(),
    refetchInterval: 30_000,
  });
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const s of inventory.data?.services ?? []) {
      if (s.stack && s.stack !== UNGROUPED) map.set(s.name, s.stack);
    }
    return map;
  }, [inventory.data]);
}

/**
 * Derive a stack from an incident title, mirroring the two title shapes
 * `incidentTitleForGroup` produces that carry enough context: a deploy-gate
 * groupKey (`release:<stack>`) names the stack directly, and a service alert
 * groupKey (`alert:service:<name>`) needs the same name→stack lookup as
 * alert events. Other shapes (db cluster, node, queue…) have no derivable
 * stack — this returns null and the row simply omits the chip.
 */
export function stackFromIncidentTitle(title: string, serviceStackMap: Map<string, string>): string | null {
  const deploy = /^Failed deploy on (.+)$/.exec(title);
  if (deploy?.[1]) return deploy[1];
  const service = /^Service (.+) disruption$/.exec(title);
  if (service?.[1]) return serviceStackMap.get(service[1]) ?? null;
  return null;
}
