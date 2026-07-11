import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DeployStatus, InvContainer, ServiceDetail } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import { DnsHealthBadge } from '@/components/geo/dns-health-badge';
import type { ServiceTab } from './service-section-strip';

const DOT_TONE: Record<string, string> = {
  running: 'bg-status-online',
  restarting: 'bg-status-progress',
  created: 'bg-status-idle',
  paused: 'bg-status-warning',
  removing: 'bg-status-warning',
  exited: 'bg-status-offline',
  dead: 'bg-status-offline',
};

interface ServicePulseRowProps {
  service: ServiceDetail;
  containers: InvContainer[] | undefined;
  deploy: DeployStatus | undefined;
  onJump: (tab: ServiceTab) => void;
}

/**
 * The pulse row — four live tiles that tell you at a glance how the service is
 * breathing. Each tile is a shortcut into its section.
 */
export function ServicePulseRow({ service, containers, deploy, onJump }: ServicePulseRowProps): React.JSX.Element {
  const trpc = useTRPC();
  const routes = useQuery(trpc.ingress.listServiceRoutes.queryOptions({ serviceId: service.id }));
  const host = routes.data?.[0]?.host;
  const shipping = deploy && deploy.phase !== 'complete' && deploy.phase !== 'failed';

  return (
    <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
      <Tile label="Replicas" onClick={() => onJump('scale')}>
        <p className="font-display text-3xl font-bold tabular-nums">
          <CountUp value={service.replicas.running} />
          <span className="text-muted-foreground text-xl font-semibold"> / {service.replicas.desired}</span>
        </p>
        <p className="mono-label text-muted-foreground mt-1 !mb-0">{service.status}</p>
      </Tile>

      <Tile label="Containers" onClick={() => onJump('inside')}>
        <p className="font-display text-3xl font-bold tabular-nums">
          <CountUp value={containers?.length ?? 0} />
        </p>
        <div className="mt-2 flex items-center gap-1">
          {(containers ?? []).slice(0, 10).map((c) => (
            <span key={c.id} className={cn('size-2 rounded-full', DOT_TONE[c.state] ?? 'bg-status-idle')} />
          ))}
          {(containers?.length ?? 0) > 10 ? (
            <span className="mono-data text-muted-foreground text-xs">+{containers!.length - 10}</span>
          ) : null}
          {containers?.length === 0 ? <span className="text-muted-foreground text-xs">none running</span> : null}
        </div>
      </Tile>

      <Tile label="Traffic" onClick={() => onJump('traffic')}>
        {host ? (
          <>
            <p className="mono-data truncate text-lg font-semibold">{host}</p>
            <div className="mt-1.5"><DnsHealthBadge host={host} compact /></div>
          </>
        ) : (
          <>
            <p className="text-muted-foreground text-lg font-semibold">Not exposed</p>
            <p className="text-primary mt-1 text-xs font-semibold">Add a route →</p>
          </>
        )}
      </Tile>

      <Tile label="Last ship" onClick={() => onJump('ship')}>
        {deploy ? (
          <>
            <p className={cn('font-display text-lg font-bold capitalize', shipping && 'text-status-progress')}>
              {shipping ? <span className="pulse-dot mr-2 inline-block align-middle" /> : null}
              {deploy.phase}
            </p>
            <p className="mono-data text-muted-foreground mt-1 truncate text-xs">
              {deploy.ready ?? 0}/{deploy.desired ?? service.replicas.desired} ready
            </p>
          </>
        ) : (
          <>
            <p className="text-muted-foreground text-lg font-semibold">Nothing yet</p>
            <p className="text-muted-foreground mt-1 text-xs">Link a repo to ship on push.</p>
          </>
        )}
      </Tile>
    </div>
  );
}

function Tile({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card-pop card-pop-hover cursor-pointer rounded-2xl p-4 text-left lg:p-5"
    >
      <p className="mono-label text-muted-foreground">{label}</p>
      <div className="mt-2 min-w-0">{children}</div>
    </button>
  );
}
