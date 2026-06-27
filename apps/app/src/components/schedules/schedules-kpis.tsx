import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarClockIcon, DatabaseIcon, ShieldCheckIcon } from 'lucide-react';
import { MetricCard, StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';

/** Top-of-page KPI strip — active schedules, store status, recent recoveries. */
export function SchedulesKpis(): React.JSX.Element {
  const trpc = useTRPC();
  const schedules = useQuery(trpc.schedules.list.queryOptions());
  const restores = useQuery(trpc.schedules.listRestores.queryOptions());
  const config = useQuery(trpc.storage.getConfig.queryOptions());

  const all = schedules.data ?? [];
  const active = all.filter((s) => !s.paused).length;
  const recoveries = restores.data?.length ?? 0;
  const storeOn = Boolean(config.data?.enabled);

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
      <MetricCard
        label="Active schedules"
        value={
          <span className="mono-data">
            <CountUp value={active} /> / {all.length}
          </span>
        }
        icon={<CalendarClockIcon className="size-4" />}
        accent
        hint={<StatusBadge tone={active > 0 ? 'online' : 'neutral'} label={active > 0 ? 'protecting' : 'none active'} />}
      />
      <MetricCard
        label="Replicated store"
        value={<span className="mono-data">{config.data?.driver ?? 'none'}</span>}
        icon={<DatabaseIcon className="size-4" />}
        hint={<StatusBadge tone={storeOn ? 'online' : 'neutral'} label={storeOn ? 'enabled' : 'off'} />}
      />
      <MetricCard
        label="Recoveries"
        value={<CountUp className="mono-data" value={recoveries} />}
        icon={<ShieldCheckIcon className="size-4" />}
        hint={recoveries === 0 ? 'all quiet — no node loss' : 'automatic restore history'}
      />
    </div>
  );
}
