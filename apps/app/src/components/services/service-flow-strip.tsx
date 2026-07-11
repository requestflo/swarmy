import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { GlobeIcon } from 'lucide-react';
import type { InvService } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface ServiceFlowStripProps {
  serviceId: string;
  /** Tapping a connected service jumps to it (coverflow in the overlay, navigate on the page). */
  onSelect: (id: string) => void;
}

const STATUS_DOT: Record<string, string> = {
  running: 'bg-status-online',
  degraded: 'bg-status-warning',
  deploying: 'bg-status-progress',
  idle: 'bg-status-idle',
  stopped: 'bg-status-idle',
};

/**
 * How data moves through this service, as a glanceable left-to-right flow:
 * internet + upstream callers → this service → what it talks to. Built from
 * the same inventory edges the canvas draws (depends + shared networks) plus
 * the service's ingress routes. Hidden entirely for isolated, unexposed
 * services — no empty chrome.
 */
export function ServiceFlowStrip({ serviceId, onSelect }: ServiceFlowStripProps): React.JSX.Element | null {
  const trpc = useTRPC();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 4_000 });
  const routes = useQuery(trpc.ingress.listServiceRoutes.queryOptions({ serviceId }));

  const inv = inventory.data;
  const byId = React.useMemo(() => new Map((inv?.services ?? []).map((s) => [s.id, s])), [inv]);
  const { upstream, downstream } = React.useMemo(() => {
    const up = new Map<string, string>();
    const down = new Map<string, string>();
    for (const e of inv?.edges ?? []) {
      if (e.from === serviceId && e.to !== serviceId) {
        if (e.kind === 'depends' || !down.has(e.to)) down.set(e.to, e.kind);
      } else if (e.to === serviceId && e.from !== serviceId) {
        if (e.kind === 'depends' || !up.has(e.from)) up.set(e.from, e.kind);
      }
    }
    return {
      upstream: [...up.entries()].map(([id, kind]) => ({ svc: byId.get(id), kind })),
      downstream: [...down.entries()].map(([id, kind]) => ({ svc: byId.get(id), kind })),
    };
  }, [inv, byId, serviceId]);

  const hosts = (routes.data ?? []).map((r) => r.host);
  const self = byId.get(serviceId);
  if (!self || (hosts.length === 0 && upstream.length === 0 && downstream.length === 0)) return null;

  return (
    <div className="mt-6">
      <p className="mono-label">Data flow</p>
      <div className="scrollbar-none mt-2 flex items-center gap-0 overflow-x-auto pt-1 pb-2">
        {hosts.length > 0 ? (
          <>
            <div className="border-primary/40 bg-primary/5 flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2">
              <GlobeIcon className="text-primary size-4" />
              <div>
                <p className="mono-data max-w-44 truncate text-sm font-semibold">{hosts[0]}</p>
                <p className="mono-label text-muted-foreground !mb-0">
                  internet{hosts.length > 1 ? ` +${hosts.length - 1}` : ''}
                </p>
              </div>
            </div>
            <FlowConnector />
          </>
        ) : null}

        {upstream.map(({ svc, kind }) =>
          svc ? (
            <React.Fragment key={svc.id}>
              <FlowChip service={svc} kind={kind} onClick={() => onSelect(svc.id)} />
              <FlowConnector muted={kind === 'network'} />
            </React.Fragment>
          ) : null,
        )}

        <div className="ink-block flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 shadow-md">
          <span className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[self.status] ?? 'bg-status-idle')} />
          <p className="max-w-44 truncate text-sm font-bold">{self.name}</p>
        </div>

        {downstream.map(({ svc, kind }) =>
          svc ? (
            <React.Fragment key={svc.id}>
              <FlowConnector muted={kind === 'network'} />
              <FlowChip service={svc} kind={kind} onClick={() => onSelect(svc.id)} />
            </React.Fragment>
          ) : null,
        )}
      </div>
    </div>
  );
}

function FlowChip({
  service,
  kind,
  onClick,
}: {
  service: InvService;
  kind: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border-border bg-card hover:border-primary/50 flex shrink-0 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-left transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <span className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[service.status] ?? 'bg-status-idle')} />
      <div>
        <p className="max-w-44 truncate text-sm font-semibold">{service.name}</p>
        <p className="mono-label text-muted-foreground !mb-0">{kind}</p>
      </div>
    </button>
  );
}

/** Animated dashes marching in the direction the data moves. */
function FlowConnector({ muted }: { muted?: boolean }): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center px-1">
      <span className={cn('flow-dashes', muted && 'flow-dashes-muted')} />
      <span
        className={cn(
          'size-0 border-y-4 border-l-6 border-y-transparent',
          muted ? 'border-l-border' : 'border-l-primary/70',
        )}
      />
    </div>
  );
}
