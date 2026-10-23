import * as React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { MoonIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { shortImage } from '@/components/apps/app-words';
import { DnsHealthBadge } from '@/components/geo/dns-health-badge';
import type { ServiceFlowNode } from './build-graph';
import { DROP_TARGET, useConnectMode } from './connect/connect-context';
import { serviceRole } from './service-role';

/** First ingress host on a service, from the `swarmy.ingress.routes` JSON label. */
function firstIngressHost(labels?: Record<string, string>): string | undefined {
  const raw = labels?.['swarmy.ingress.routes'];
  if (!raw) return undefined;
  try {
    return (JSON.parse(raw) as { host?: string }[]).find((r) => typeof r?.host === 'string' && r.host)?.host;
  } catch {
    return undefined;
  }
}

const HANDLE: React.CSSProperties = {
  opacity: 0,
  width: 6,
  height: 6,
  minWidth: 0,
  minHeight: 0,
  border: 'none',
  background: 'transparent',
};

/**
 * One part of an app on the "How it is built" canvas. Summary: the name and a
 * plain line about what it does. Controls adds the tech line — name · copies ·
 * image · ports — and the address it answers on. Selected = coral ring (the
 * bottom sheet shows the rest).
 */
export function ServiceNode({ id, data, selected }: NodeProps<ServiceFlowNode>): React.JSX.Element {
  const { service, tone, metric } = data;
  const connect = useConnectMode();
  const drop = connect.on && !!connect.from && connect.from !== id;
  const { replicas, ports, status, scaleToZero } = service;
  const idle = status === 'idle';
  const host = firstIngressHost(service.labels);
  const tech = [
    service.name,
    `×${replicas.running}/${replicas.desired}`,
    shortImage(service.image),
    ...ports.slice(0, 2).map((p) => `:${p.published ?? p.target}`),
  ].join(' · ');

  return (
    <div
      className={cn(
        'bg-card border-border relative w-[248px] cursor-pointer rounded-xl border px-3.5 py-3 transition-shadow',
        'hover:border-foreground/25',
        selected && 'ring-primary/70 border-primary/60 ring-2',
        connect.from === id && 'ring-primary ring-2',
      )}
    >
      <Handle id="in" type="target" position={Position.Left} isConnectable={drop} style={drop ? DROP_TARGET : HANDLE} />
      <Handle id="l1" type="target" position={Position.Left} style={{ ...HANDLE, top: '40%' }} isConnectable={false} />
      <Handle id="l2" type="target" position={Position.Left} style={{ ...HANDLE, top: '68%' }} isConnectable={false} />
      <Handle id="r1" type="source" position={Position.Right} style={{ ...HANDLE, top: '40%' }} isConnectable={false} />
      <Handle id="r2" type="source" position={Position.Right} style={{ ...HANDLE, top: '68%' }} isConnectable={false} />
      {connect.on ? (
        <Handle
          id="out"
          type="source"
          position={Position.Right}
          isConnectable
          title={`Drag from ${service.name} to what it should use`}
          className="!bg-primary !border-card !z-10 !size-3.5 !border-2 pointer-coarse:!size-5"
        />
      ) : null}

      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn('size-2 shrink-0 rounded-full', tone === 'progress' && 'animate-pulse motion-reduce:animate-none')}
          style={{ background: `var(--status-${tone})` }}
        />
        <span className="truncate text-[14.5px] font-semibold">{service.name}</span>
        {(idle || scaleToZero) && (
          <span className="text-tone-idle ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold">
            <MoonIcon aria-hidden className="size-3" />
            {idle ? 'asleep' : 'sleeps when quiet'}
          </span>
        )}
      </div>
      <p className="text-muted-foreground mt-0.5 flex items-baseline gap-2 text-[12.5px]">
        <span className="truncate">{serviceRole(service)}</span>
        {metric ? <span className="text-foreground ml-auto shrink-0 font-mono text-[11px]">{metric.rate}</span> : null}
      </p>
      <Depth at="controls">
        <p className="text-muted-foreground mt-1.5 line-clamp-2 font-mono text-[11px] leading-snug">{tech}</p>
        {metric ? <p className="text-muted-foreground mt-0.5 font-mono text-[11px]">{metric.tech}</p> : null}
        {host ? (
          <div className="mt-1.5 flex items-center gap-1.5">
            <DnsHealthBadge host={host} compact />
            <span className="text-muted-foreground truncate font-mono text-[11px]">{host}</span>
          </div>
        ) : null}
      </Depth>
    </div>
  );
}
