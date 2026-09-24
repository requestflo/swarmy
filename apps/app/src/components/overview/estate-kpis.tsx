import * as React from 'react';
import { ActivityIcon, BellIcon, ServerIcon, SirenIcon } from 'lucide-react';
import type { EstateSummary } from '@/lib/use-estate-summary';
import { KpiCard } from './kpi-card';

/** The four estate KPIs, all read from the one settled summary. */
export function EstateKpis({ estate }: { estate: EstateSummary }): React.JSX.Element {
  const { nodes, services, alerts, incidents } = estate;
  const allNodesUp = nodes.total > 0 && nodes.online === nodes.total;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <KpiCard
        to="/nodes"
        icon={<ServerIcon className="size-4" />}
        label="Nodes online"
        value={nodes.online}
        suffix={`/${nodes.total}`}
        tone={allNodesUp ? 'online' : nodes.online > 0 ? 'warning' : 'idle'}
      />
      <KpiCard
        to="/"
        icon={<ActivityIcon className="size-4" />}
        label="Services running"
        value={services.running}
        suffix={`/${services.total}`}
        tone={services.running === services.total ? 'online' : 'progress'}
      />
      <KpiCard
        to="/alerts"
        icon={<BellIcon className="size-4" />}
        label="Alerts firing"
        value={alerts.firing}
        tone={alerts.firing > 0 ? 'warning' : 'online'}
      />
      <KpiCard
        to="/incidents"
        icon={<SirenIcon className="size-4" />}
        label="Open incidents"
        value={incidents.open}
        tone={incidents.open > 0 ? 'offline' : 'online'}
      />
    </div>
  );
}
