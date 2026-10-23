import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { spikeChannels } from './issue-chart-math';

/** "alerts → #ops Slack": where a spike in this issue gets sent (the `error-spike` rules). */
export function IssueAlertsLine({ stack }: { stack: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const rules = useQuery(trpc.alerts.rules.queryOptions());
  const channels = useQuery(trpc.alerts.channels.queryOptions());
  if (!rules.data || !channels.data) return null;
  const out = spikeChannels(rules.data, channels.data, stack);
  const words =
    out.channels.length > 0
      ? `alerts → ${out.channels.map((c) => c.name).join(', ')}`
      : out.rules > 0
        ? 'spike alerts on · no channel yet'
        : 'no alert on spikes';
  return (
    <Link to="/alerts" className="mono-data text-xs underline-offset-2 hover:underline">
      {words}
    </Link>
  );
}
