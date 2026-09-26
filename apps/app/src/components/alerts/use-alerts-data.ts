import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AlertEventView, AlertQuietHoursView, AlertRuleView, AlertsOverview, NotificationChannelView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { ruleForEvent } from './rule-sentence';

export interface AlertsData {
  ready: boolean;
  error: unknown;
  overview: AlertsOverview | undefined;
  rules: AlertRuleView[];
  channels: NotificationChannelView[];
  /** The newest 200 events (firing + resolved) — the rules' real history. */
  events: AlertEventView[];
  /** Open events per rule id (every rule owns its events; a ruleless one goes to the first rule covering it). */
  firingByRule: Map<string, AlertEventView[]>;
  /** The workspace quiet hours (undefined while loading). */
  quietHours: AlertQuietHoursView | undefined;
  refetch: () => void;
}

/** One read of the alerting spine for the whole page (list, editor, channels share it). */
export function useAlertsData(): AlertsData {
  const trpc = useTRPC();
  const overview = useQuery({ ...trpc.alerts.overview.queryOptions(), refetchInterval: 10_000 });
  const rules = useQuery({ ...trpc.alerts.rules.queryOptions(), refetchInterval: 30_000 });
  const channels = useQuery({ ...trpc.alerts.channels.queryOptions(), refetchInterval: 30_000 });
  const events = useQuery({ ...trpc.alerts.events.queryOptions({ limit: 200 }), refetchInterval: 10_000 });
  const quietHours = useQuery({ ...trpc.alerts.quietHours.queryOptions(), refetchInterval: 60_000 });

  const firingByRule = React.useMemo(() => {
    const map = new Map<string, AlertEventView[]>();
    for (const e of events.data ?? []) {
      if (e.status !== 'firing') continue;
      const id = e.ruleId ?? ruleForEvent(rules.data ?? [], e.signal, e.resource)?.id;
      if (!id) continue;
      map.set(id, [...(map.get(id) ?? []), e]);
    }
    return map;
  }, [events.data, rules.data]);

  return {
    ready: rules.isSuccess && channels.isSuccess && events.isSuccess && overview.isSuccess,
    error: rules.error ?? channels.error ?? events.error ?? overview.error,
    overview: overview.data,
    rules: rules.data ?? [],
    channels: channels.data ?? [],
    events: events.data ?? [],
    firingByRule,
    quietHours: quietHours.data,
    refetch: () => {
      void rules.refetch();
      void channels.refetch();
      void events.refetch();
      void overview.refetch();
      void quietHours.refetch();
    },
  };
}
