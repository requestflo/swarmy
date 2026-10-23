import * as React from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { IncidentView } from '@swarmy/core';
import { incidentScope } from '@/components/incidents/incident-scope';
import { useWordsContext } from '@/components/incidents/use-incident-scope';
import { useTRPC } from '@/integrations/trpc';
import { WEEK_MS } from './time-travel-model';

/** The incidents of the week worth reading timelines for (a busy week stays bounded). */
const MAX = 20;

/**
 * This app's incidents of the last 7 days. An incident has no app link, so
 * which app it hit is read off its timeline (`incidentScope`, the incident
 * room's rule) — one `incidents.get` per incident opened this week.
 */
export function useAppIncidents(stack: string, now: number): { data: IncidentView[] | undefined; isError: boolean } {
  const trpc = useTRPC();
  const list = useQuery({ ...trpc.incidents.list.queryOptions({ limit: 100 }), refetchInterval: 30_000 });
  const { ctx } = useWordsContext();
  const recent = React.useMemo(
    () => (list.data ?? []).filter((i) => Date.parse(i.openedAt) >= now - WEEK_MS).slice(0, MAX),
    [list.data, now],
  );
  const details = useQueries({
    queries: recent.map((i) => ({ ...trpc.incidents.get.queryOptions({ id: i.id }), refetchInterval: 60_000 })),
  });
  const settled = Boolean(list.data) && details.every((d) => d.data || d.isError);
  const data = settled
    ? recent.filter((_, k) => {
        const detail = details[k]?.data;
        return detail ? incidentScope(detail, ctx).app === stack : false;
      })
    : undefined;
  return { data, isError: list.isError };
}
