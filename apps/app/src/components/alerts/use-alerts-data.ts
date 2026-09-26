import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AlertEventView, AlertRuleView, AlertsOverview, NotificationChannelView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { governingRule } from './rule-sentence';

export interface AlertsData {
  ready: boolean;
  error: unknown;
  overview: AlertsOverview | undefined;
  rules: AlertRuleView[];
  channels: NotificationChannelView[];
  /** The newest 200 events (firing + resolved) — the rules' real history. */
  events: AlertEventView[];
  /** Open events per rule id (an unattributed event goes to the signal's governing rule). */
  firingByRule: Map<string, AlertEventView[]>;
  refetch: () => void;
}

/** One read of the alerting spine for the whole page (list, editor, channels share it). */
export function useAlertsData(): AlertsData {
  const trpc = useTRPC();
  const overview = useQuery({ ...trpc.alerts.overview.queryOptions(), refetchInterval: 10_000 });
  const rules = useQuery({ ...trpc.alerts.rules.queryOptions(), refetchInterval: 30_000 });
  const channels = useQuery({ ...trpc.alerts.channels.queryOptions(), refetchInterval: 30_000 });
  const events = useQuery({ ...trpc.alerts.events.queryOptions({ limit: 200 }), refetchInterval: 10_000 });

  const firingByRule = React.useMemo(() => {
    const map = new Map<string, AlertEventView[]>();
    for (const e of events.data ?? []) {
      if (e.status !== 'firing') continue;
      const id = e.ruleId ?? governingRule(rules.data ?? [], e.signal)?.id;
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
    refetch: () => {
      void rules.refetch();
      void channels.refetch();
      void events.refetch();
      void overview.refetch();
    },
  };
}
