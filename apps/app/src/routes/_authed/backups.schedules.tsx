import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { SchedulesCreateDialog } from '@/components/schedules/schedules-create-dialog';
import { SchedulesKpis } from '@/components/schedules/schedules-kpis';
import { SchedulesList } from '@/components/schedules/schedules-list';
import { ReplicatedStorePanel } from '@/components/schedules/replicated-store-panel';
import { DrRecoveryList } from '@/components/schedules/dr-recovery-list';

export const Route = createFileRoute('/_authed/backups/schedules')({
  component: SchedulesPage,
});

function SchedulesPage(): React.JSX.Element {
  const trpc = useTRPC();
  const targets = useQuery(trpc.backups.listTargets.queryOptions());
  const targetRows = (targets.data ?? []).map((t) => ({ id: t.id, name: t.name }));

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Data · DR"
        title={
          <>
            Backups that <em>run themselves</em>.
          </>
        }
        description="Scheduled snapshots, a replicated object store, and restore-on-recovery — disaster recovery that needs no babysitting."
        actions={<SchedulesCreateDialog targets={targetRows} />}
      />

      <SchedulesKpis />

      <div className="mt-6">
        <SchedulesList />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <ReplicatedStorePanel />
        <DrRecoveryList />
      </div>
    </div>
  );
}
