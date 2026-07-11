import * as React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { MoonIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import type { InvContainer } from '@swarmy/core';
import { DnsHealthBadge } from '@/components/geo/dns-health-badge';
import type { ServiceFlowNode } from './build-graph';

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

/** Container dot colour: running is live; in-flight is progress; gone is offline. */
function containerTone(state: string): string {
  const s = state.toLowerCase();
  if (s === 'running') return 'online';
  if (/start|pend|prepar|assign|accept|new|pull/.test(s)) return 'progress';
  if (/exit|fail|dead|reject|orphan|shutdown|complete|remov/.test(s)) return 'offline';
  return 'idle';
}

function ContainerDots({ containers }: { containers: InvContainer[] }): React.JSX.Element {
  if (containers.length === 0)
    return <span className="text-muted-foreground text-[10px]">no containers</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {containers.map((c) => (
        <span
          key={c.id}
          title={`${c.name} · ${c.state}`}
          className="size-2 rounded-full"
          style={{ background: `var(--status-${containerTone(c.state)})` }}
        />
      ))}
    </div>
  );
}

/**
 * A live service as a draggable canvas card (Hot Signal): status dot, image tag,
 * replica health, a dot per container, exposed ports, and a quiet scale-to-zero /
 * idle affordance (idle is intentional — a paused moon, never an error). Tapping
 * the card transports you into the service page — the hover "Open" chip sells it.
 */
export function ServiceNode({ data }: NodeProps<ServiceFlowNode>): React.JSX.Element {
  const { service, tone } = data;
  const { replicas, containers, ports, status, scaleToZero } = service;
  const idle = status === 'idle';
  const replicasOk = replicas.desired > 0 && replicas.running >= replicas.desired;

  return (
    <div className="card-pop group hover:ring-primary/60 relative w-[248px] cursor-pointer rounded-2xl px-4 py-3 transition-shadow hover:shadow-[0_14px_34px_-14px_var(--primary)] hover:ring-2">
      <span className="bg-primary text-primary-foreground pointer-events-none absolute -top-2.5 right-3 rounded-full px-2 py-0.5 text-[10px] font-bold opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
        Open →
      </span>
      <Handle id="l1" type="target" position={Position.Left} style={{ ...HANDLE, top: '40%' }} isConnectable={false} />
      <Handle id="l2" type="target" position={Position.Left} style={{ ...HANDLE, top: '68%' }} isConnectable={false} />
      <Handle id="r1" type="source" position={Position.Right} style={{ ...HANDLE, top: '40%' }} isConnectable={false} />
      <Handle id="r2" type="source" position={Position.Right} style={{ ...HANDLE, top: '68%' }} isConnectable={false} />

      <div className="flex items-center gap-2">
        <span
          className={cn('size-2.5 shrink-0 rounded-full', tone === 'progress' && 'animate-pulse')}
          style={{ background: `var(--status-${tone})` }}
        />
        <span className="font-display truncate text-[15px] font-bold tracking-tight">{service.name}</span>
        {(idle || scaleToZero) && (
          <span className="bg-status-idle/15 text-status-idle ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold">
            <MoonIcon className="size-3" />
            {idle ? 'idle' : 'scale-to-zero'}
          </span>
        )}
      </div>

      <p className="mono-data text-muted-foreground mt-1.5 truncate text-xs">{service.image}</p>
      {firstIngressHost(service.labels) && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <DnsHealthBadge host={firstIngressHost(service.labels)!} compact />
          <span className="mono-data text-muted-foreground truncate text-[11px]">{firstIngressHost(service.labels)}</span>
        </div>
      )}

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span
          className={cn(
            'mono-data text-xs',
            idle ? 'text-status-idle' : replicasOk ? 'text-status-online' : 'text-status-warning',
          )}
        >
          {replicas.running}/{replicas.desired} up
        </span>
        {ports.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1">
            {ports.slice(0, 3).map((p, i) => (
              <span
                key={`${p.target}-${i}`}
                className="bg-muted text-muted-foreground mono-data rounded-md px-1.5 py-0.5 text-[10px]"
              >
                :{p.published ?? p.target}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="border-border/70 mt-2.5 flex items-center gap-2 border-t pt-2.5">
        <span className="mono-label !mb-0 !text-[9px]">ctr</span>
        <ContainerDots containers={containers} />
      </div>
    </div>
  );
}
