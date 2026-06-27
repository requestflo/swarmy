import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CreateScheduleDialog } from '@/components/backups/create-schedule-dialog';
import { SchedulesTable } from '@/components/backups/schedules-table';
import { ReplicatedStoreCard } from '@/components/backups/replicated-store-card';
import { DrSettingsCard } from '@/components/backups/dr-settings-card';

export const Route = createFileRoute('/_authed/backups/schedules')({
  component: SchedulesPage,
});

function SchedulesPage(): React.JSX.Element {
  const trpc = useTRPC();
  const targets = useQuery(trpc.backups.listTargets.queryOptions());
  const schedules = useQuery(trpc.schedules.list.queryOptions());

  const targetRows = (targets.data ?? []).map((t) => ({ id: t.id, name: t.name }));
  const activeCount = (schedules.data ?? []).filter((s) => !s.paused).length;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Backups · DR"
        title={
          <>
            Automatic <em>protection</em>.
          </>
        }
        description="Scheduled backups, a replicated object store, and restore-on-recovery — DR that runs itself."
        actions={
          <StatusBadge
            tone={activeCount > 0 ? 'online' : 'neutral'}
            label={activeCount > 0 ? `${activeCount} active` : 'No schedules'}
          />
        }
      />

      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            Schedules
            <CreateScheduleDialog targets={targetRows} />
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <SchedulesTable />
        </CardContent>
      </Card>

      <div className="mt-6">
        <ReplicatedStoreCard />
      </div>

      <div className="mt-6">
        <DrSettingsCard />
      </div>
    </div>
  );
}
