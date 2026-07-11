import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { SectionHeader } from '@/components/section-header';
import { ChannelsPanel } from './channels-panel';
import { FiringEvents } from './firing-events';
import { RulesTable } from './rules-table';

/**
 * Operations → Alerts: the firing feed (ack), the rule set (toggle / edit
 * thresholds / bind channels) and the notification channels (add / test).
 */
export function AlertsPage(): React.JSX.Element {
  const trpc = useTRPC();
  const overview = useQuery({
    ...trpc.alerts.overview.queryOptions(),
    refetchInterval: 10_000,
  });

  const firing = overview.data?.firing ?? 0;
  const critical = overview.data?.firingCritical ?? 0;
  const title = overview.isLoading ? (
    <>Alerts.</>
  ) : firing === 0 ? (
    <>
      All <em>quiet</em>.
    </>
  ) : critical > 0 ? (
    <>
      {firing} firing — {critical} <em>critical</em>.
    </>
  ) : (
    <>
      {firing} {firing === 1 ? 'alert needs' : 'alerts need'} <em>you</em>.
    </>
  );

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <SectionHeader
        section="Operations"
        title={title}
        description="swarmy watches nodes, services, databases, backups, disks, queues and error rates — and tells you before your users do. Pick where the messages land, tune the rules if you like."
      />
      <div className="space-y-8">
        <FiringEvents />
        <div className="grid gap-8 xl:grid-cols-[3fr_2fr]">
          <RulesTable />
          <ChannelsPanel />
        </div>
      </div>
    </div>
  );
}
