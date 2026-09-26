import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AlertEventView, AuditEntryView, IncidentView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { stackFromIncidentTitle, useServiceStackMap } from '@/components/alerts/use-service-stack-map';
import { plainWords } from '@/components/incidents/incident-words';
import { useWordsContext } from '@/components/incidents/use-incident-scope';
import { fromAlert, fromAudit, fromIncident, markSuspects, plainItem, type ActivityItem } from './activity-items';

/** Deploys, alerts, incidents and audit events, merged newest first. */
export function useActivityFeed(): {
  items: ActivityItem[];
  firing: AlertEventView[];
  openIncidents: IncidentView[];
  audit: AuditEntryView[];
  /** Plain words for automation text (resource keys, release ids, glossary). */
  words: (text: string) => string;
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
  const stackMap = useServiceStackMap();
  const { ctx } = useWordsContext();
  const words = React.useCallback((t: string): string => plainWords(t, ctx), [ctx]);

  const items = React.useMemo(() => {
    const out: ActivityItem[] = [
      ...(firing.data ?? []).map(fromAlert),
      ...(resolved.data ?? []).map(fromAlert),
      ...(incidents.data ?? []).map(fromIncident),
      ...(audit.data?.entries ?? []).filter((a) => !a.action.startsWith('alert.')).map(fromAudit),
    ];
    // An open incident names its app directly, or through a service it names first.
    const incidentApps = (incidents.data ?? [])
      .filter((i) => i.status === 'open')
      .flatMap((i) => {
        const app = stackFromIncidentTitle(i.title, stackMap) ?? stackMap.get(i.title.split(/\s/)[0] ?? '');
        return app ? [{ app, openedAt: i.openedAt }] : [];
      });
    return markSuspects(out, incidentApps)
      .map((it) => plainItem(it, words))
      .sort((a, b) => b.at.localeCompare(a.at));
  }, [firing.data, resolved.data, incidents.data, audit.data, stackMap, words]);

  return {
    items,
    firing: firing.data ?? [],
    openIncidents: (incidents.data ?? []).filter((i) => i.status === 'open'),
    audit: audit.data?.entries ?? [],
    words,
    isLoading: all.some((q) => q.isLoading),
    error: all.find((q) => q.isError)?.error ?? null,
    refetch: () => all.forEach((q) => void q.refetch()),
  };
}
