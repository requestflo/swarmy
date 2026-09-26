import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useTRPC } from '@/integrations/trpc';
import type { DeployEvent } from './deploy-events';

export interface DeployStream {
  events: DeployEvent[];
  /** When the deploy started, by the controller's clock (null until known). */
  startedAt: number | null;
  /** No event for 10 s and not finished: the polled state takes over where it's further along. */
  stale: boolean;
  /** The stream said it's over (live, failed, or no longer watched). */
  ended: boolean;
}

const QUIET_MS = 10_000;
const NONE: DeployStream = { events: [], startedAt: null, stale: true, ended: false };

/**
 * A traced deploy's events: `deploys.get` for its start and the buffer so
 * far, then `deploys.events` (replay + live tail), de-duplicated by seq.
 * With no deploy id (a reload, an older controller) it returns nothing and
 * the tracker runs on polling alone.
 */
export function useDeployEvents(deployId: string | null): DeployStream {
  const trpc = useTRPC();
  const on = Boolean(deployId);
  const [events, setEvents] = React.useState<DeployEvent[]>([]);
  const [lastAt, setLastAt] = React.useState(() => Date.now());
  const [now, setNow] = React.useState(() => Date.now());
  const add = React.useCallback((more: DeployEvent[]) => {
    if (!more.length) return;
    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.seq));
      const fresh = more.filter((e) => !seen.has(e.seq));
      return fresh.length ? [...prev, ...fresh].sort((a, b) => a.seq - b.seq) : prev;
    });
    setLastAt(Date.now());
  }, []);

  const meta = useQuery({ ...trpc.deploys.get.queryOptions({ deployId: deployId ?? 'dep_00000000' }), enabled: on, retry: false, staleTime: Infinity });
  React.useEffect(() => {
    if (meta.data) add(meta.data.events as DeployEvent[]);
  }, [meta.data, add]);
  useSubscription(
    trpc.deploys.events.subscriptionOptions(
      { deployId: deployId ?? 'dep_00000000' },
      { enabled: on && !meta.isError, onData: (e) => add([e as DeployEvent]) },
    ),
  );

  React.useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(t);
  }, [on]);

  if (!on || meta.isError) return NONE;
  const ended = Boolean(meta.data?.done) || events.some((e) => e.stage === 'health' && e.status === 'done');
  return { events, startedAt: meta.data?.startedAt ?? null, stale: !ended && now - lastAt > QUIET_MS, ended };
}
