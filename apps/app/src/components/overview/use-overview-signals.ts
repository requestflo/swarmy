import { useQuery } from '@tanstack/react-query';
import type { AlertEventView, AuditEntryView, IncidentView, ReleaseView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

export interface OverviewSignals {
  /** Settled: every list below has answered (so "nothing" really means nothing). */
  ready: boolean;
  firing: AlertEventView[];
  openIncidents: IncidentView[];
  releases: ReleaseView[];
  audit: AuditEntryView[];
}

/**
 * What the Overview needs beyond the estate numbers: the firing alerts and
 * open incidents behind the next action, and the recent releases and audit
 * rows behind "Today".
 */
export function useOverviewSignals(): OverviewSignals {
  const trpc = useTRPC();
  const firing = useQuery({ ...trpc.alerts.events.queryOptions({ status: 'firing', limit: 10 }), refetchInterval: 10_000 });
  const incidents = useQuery({ ...trpc.incidents.list.queryOptions({ status: 'open', limit: 10 }), refetchInterval: 15_000 });
  const releases = useQuery({ ...trpc.releases.list.queryOptions({ limit: 12 }), refetchInterval: 15_000 });
  const audit = useQuery({ ...trpc.audit.list.queryOptions({ limit: 60 }), refetchInterval: 30_000 });
  return {
    ready: [firing, incidents, releases, audit].every((q) => !q.isPending),
    firing: firing.data ?? [],
    openIncidents: incidents.data ?? [],
    releases: releases.data ?? [],
    audit: audit.data?.entries ?? [],
  };
}
