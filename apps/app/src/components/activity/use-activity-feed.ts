import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AlertEventView, AuditEntryView, IncidentView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { fromAlert, fromAudit, fromIncident, type ActivityItem } from './activity-items';

/** Deploys, alerts, incidents and audit events, merged newest first. */
export function useActivityFeed(): {
  items: ActivityItem[];
  firing: AlertEventView[];
  openIncidents: IncidentView[];
  audit: AuditEntryView[];
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
} {
  const trpc = useTRPC();
  const firing = useQuery({ ...trpc.alerts.events.queryOptions({ status: 'firing', limit: 50 }), refetchInterval: 10_000 });
  const resolved = useQuery({ ...trpc.alerts.events.queryOptions({ status: 'resolved', limit: 30 }), refetchInterval: 30_000 });
  const incidents = useQuery({ ...trpc.incidents.list.queryOptions({ limit: 30 }), refetchInterval: 15_000 });
  const audit = useQuery({ ...trpc.audit.list.queryOptions({ limit: 60 }), refetchInterval: 30_000 });
  const all = [firing, resolved, incidents, audit];

  const items = React.useMemo(() => {
    const out: ActivityItem[] = [
      ...(firing.data ?? []).map(fromAlert),
      ...(resolved.data ?? []).map(fromAlert),
      ...(incidents.data ?? []).map(fromIncident),
      ...(audit.data?.entries ?? []).filter((a) => !a.action.startsWith('alert.')).map(fromAudit),
    ];
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }, [firing.data, resolved.data, incidents.data, audit.data]);

  return {
    items,
    firing: firing.data ?? [],
    openIncidents: (incidents.data ?? []).filter((i) => i.status === 'open'),
    audit: audit.data?.entries ?? [],
    isLoading: all.some((q) => q.isLoading),
    error: all.find((q) => q.isError)?.error ?? null,
    refetch: () => all.forEach((q) => void q.refetch()),
  };
}
