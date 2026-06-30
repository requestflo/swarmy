import * as React from 'react';
import { type NodeProps } from '@xyflow/react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  BoxesIcon,
  CpuIcon,
  MapPinIcon,
  MemoryStickIcon,
} from 'lucide-react';
import {
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  cn,
  toast,
} from '@swarmy/ui';
import { NODE_STATUS_TONE, type NodeSummary } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { bytes, cores, pct } from '@/lib/format';
import type { InfraFlowNode } from './infra-canvas';

/** Status dot token for a node (neutral falls back to the idle token). */
function toneToken(status: string): string {
  const tone = NODE_STATUS_TONE[status] ?? 'neutral';
  return tone === 'neutral' ? 'idle' : tone;
}

/** A role chip (ingress / outlet) — a `nodrag` toggle that calls nodes.setRole. */
function RoleChip({
  active,
  pending,
  icon,
  label,
  onToggle,
}: {
  active: boolean;
  pending: boolean;
  icon: React.ReactNode;
  label: string;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={pending}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        'nodrag inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold transition-colors disabled:opacity-50',
        active
          ? 'border-transparent bg-primary/15 text-primary'
          : 'border-border text-muted-foreground hover:bg-muted',
      )}
      aria-pressed={active}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * A swarm node as a draggable canvas card (Hot Signal): status dot, hostname,
 * manager badge, ingress/outlet role chips, a region picker, live CPU/MEM
 * capacity bars and a running-container count. Role + region mutate Docker node
 * labels (nodes.setRole / nodes.setRegion); the card itself navigates to the
 * node detail (handled by the canvas) — interactive controls stop propagation so
 * they neither drag the node nor open the detail.
 */
export function InfraNode({ data }: NodeProps<InfraFlowNode>): React.JSX.Element {
  const { node } = data as { node: NodeSummary };
  const trpc = useTRPC();
  const qc = useQueryClient();

  const regions = useQuery(trpc.region.knownRegions.queryOptions());
  // Per-node running-container count (only meaningful while the node is online).
  const containers = useQuery({
    ...trpc.nodes.containers.queryOptions({ nodeId: node.id }),
    refetchInterval: 6_000,
    enabled: node.status === 'online',
  });
  const running = (containers.data ?? []).filter((c) => c.state === 'running').length;

  const invalidate = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: trpc.nodes.list.queryKey() });
    void qc.invalidateQueries({ queryKey: trpc.region.knownRegions.queryKey() });
  }, [qc, trpc]);

  const setRole = useMutation(
    trpc.nodes.setRole.mutationOptions({
      onSuccess: invalidate,
      onError: (e) => toast.error(e.message),
    }),
  );
  const setRegion = useMutation(
    trpc.nodes.setRegion.mutationOptions({
      onSuccess: () => {
        toast.success('Region updated');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const tone = toneToken(node.status);
  const regionOptions = React.useMemo(() => {
    // Defensive: demo mode (and any fallback) may not return an array here.
    const known = Array.isArray(regions.data) ? regions.data : [];
    const set = new Set(known);
    if (node.region) set.add(node.region);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [regions.data, node.region]);
  const rolePending = setRole.isPending;

  return (
    <div
      className={cn(
        'card-pop w-[272px] cursor-pointer rounded-2xl px-4 py-3 transition-shadow',
        'hover:shadow-[0_14px_34px_-16px_rgba(0,0,0,0.4)]',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn('size-2.5 shrink-0 rounded-full', tone === 'progress' && 'animate-pulse')}
          style={{ background: `var(--status-${tone})` }}
        />
        <span className="font-display truncate text-[15px] font-bold tracking-tight">{node.name}</span>
        {node.role === 'manager' && (
          <span className="bg-ink text-ink-foreground ml-auto inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold">
            manager
          </span>
        )}
      </div>

      <div className="text-muted-foreground mt-1.5 flex items-center gap-2">
        <p className="mono-data truncate text-xs">{node.hostname}</p>
        <StatusBadge tone={NODE_STATUS_TONE[node.status] ?? 'neutral'} label={node.status} />
      </div>

      {/* Roles + region — interactive (nodrag, stop propagation). */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <RoleChip
          active={node.ingress === true}
          pending={rolePending}
          icon={<ArrowDownToLineIcon className="size-3" />}
          label="ingress"
          onToggle={() => setRole.mutate({ id: node.id, ingress: !node.ingress })}
        />
        <RoleChip
          active={node.outlet === true}
          pending={rolePending}
          icon={<ArrowUpFromLineIcon className="size-3" />}
          label="outlet"
          onToggle={() => setRole.mutate({ id: node.id, outlet: !node.outlet })}
        />
        <div
          className="nodrag ml-auto"
          onClick={(e) => e.stopPropagation()}
          role="presentation"
        >
          <Select
            value={node.region ?? undefined}
            onValueChange={(region) => setRegion.mutate({ id: node.id, region })}
            disabled={setRegion.isPending}
          >
            <SelectTrigger className="h-7 w-auto gap-1 rounded-full px-2.5 text-[11px]">
              <MapPinIcon className="size-3" />
              <SelectValue placeholder="Region" />
            </SelectTrigger>
            <SelectContent>
              {regionOptions.length === 0 ? (
                <SelectItem value="default">default</SelectItem>
              ) : (
                regionOptions.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Capacity — live CPU/MEM bars over total cores/memory. */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Capacity
          icon={<CpuIcon className="size-3.5" />}
          label={`CPU ${pct(node.live?.cpuPercent)}`}
          value={node.live?.cpuPercent ?? 0}
          sub={cores(node.resources.cpus)}
        />
        <Capacity
          icon={<MemoryStickIcon className="size-3.5" />}
          label={`MEM ${pct(node.live?.memPercent)}`}
          value={node.live?.memPercent ?? 0}
          sub={bytes(node.resources.memBytes)}
        />
      </div>

      <div className="border-border/70 text-muted-foreground mt-2.5 flex items-center gap-2 border-t pt-2.5 text-[11px]">
        <BoxesIcon className="size-3.5" />
        <span className="mono-data">{running}</span>
        <span>running {running === 1 ? 'container' : 'containers'}</span>
      </div>
    </div>
  );
}

function Capacity({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  sub: string;
}): React.JSX.Element {
  return (
    <div>
      <div className="mono-label flex items-center gap-1">
        {icon}
        {label}
      </div>
      <Progress value={value} className="mt-1.5" />
      <p className="text-muted-foreground mt-1 text-[11px]">{sub}</p>
    </div>
  );
}
