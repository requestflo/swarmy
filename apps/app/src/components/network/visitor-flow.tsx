import * as React from 'react';
import { ArrowRightIcon, DoorOpenIcon, UsersIcon } from 'lucide-react';
import { Tech } from '@/components/calm';
import type { HubDomain } from './use-network';

/**
 * The visitor → front door → app picture, drawn from the same domain rows as
 * the list (a view of the list, never a separate truth).
 */
export function VisitorFlow({
  domains,
  frontDoors,
  driverLabel,
  geoOn,
}: {
  domains: HubDomain[];
  frontDoors: number;
  driverLabel: string;
  geoOn: boolean;
}): React.JSX.Element {
  const apps = [...new Set(domains.map((d) => d.stack))];
  return (
    <div className="grid items-center gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1.4fr)]">
      <Box icon={<UsersIcon className="size-4" />} title="Visitors" line={geoOn ? 'Sent to the nearest front door' : 'Every visitor'} />
      <ArrowRightIcon aria-hidden className="text-muted-foreground mx-auto size-4 rotate-90 md:rotate-0" />
      <Box
        icon={<DoorOpenIcon className="size-4" />}
        title={frontDoors === 1 ? 'One front door' : `${frontDoors} front doors`}
        line="Checks HTTPS, then passes the visit on"
        tech={`${driverLabel} · ports 80/443`}
      />
      <ArrowRightIcon aria-hidden className="text-muted-foreground mx-auto size-4 rotate-90 md:rotate-0" />
      <ul className="flex min-w-0 flex-col gap-1.5">
        {apps.map((app) => {
          const hosts = domains.filter((d) => d.stack === app);
          return (
            <li key={app} className="border-border min-w-0 rounded-xl border px-3 py-2">
              <p className="text-[13.5px] font-semibold">{app}</p>
              <p className="text-muted-foreground truncate font-mono text-[11px]">{hosts.map((h) => h.host).join(' · ')}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Box({
  icon,
  title,
  line,
  tech,
}: {
  icon: React.ReactNode;
  title: string;
  line: string;
  tech?: string;
}): React.JSX.Element {
  return (
    <div className="border-border flex flex-col gap-1 rounded-xl border px-3.5 py-3">
      <p className="flex items-center gap-2 text-[14px] font-semibold">
        <span className="text-primary">{icon}</span>
        {title}
      </p>
      <p className="text-muted-foreground text-[12.5px]">{line}</p>
      {tech ? <Tech>{tech}</Tech> : null}
    </div>
  );
}
