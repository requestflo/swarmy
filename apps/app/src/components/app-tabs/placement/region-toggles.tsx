import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InvService, NodeSummary } from '@swarmy/core';
import { Button, cn, toast } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';

const copies = (n: number): string => `${n} ${n === 1 ? 'copy' : 'copies'}`;

/**
 * "Run web in" (board AppPlacement): one switch per region. Switching asks
 * once, in a sentence that says what moves, then declares the region's
 * copies (`region.set`); swarmy runs them there. The last region on can't be
 * switched off — the part would have nowhere to run.
 */
export function RegionToggles({ name, inv, declared, known, nodes }: { name: string; inv: InvService; declared: Map<string, number>; known: string[]; nodes: NodeSummary[] }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [ask, setAsk] = React.useState<{ region: string; on: boolean } | null>(null);
  const set = useMutation(
    trpc.region.set.mutationOptions({
      onSuccess: (_r, v) => {
        toast.success(v.replicas > 0 ? `${name} runs in ${v.region}` : `${name} stopped running in ${v.region}`);
        setAsk(null);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const each = declared.size ? Math.max(...declared.values()) : Math.max(1, inv.replicas.desired);
  const servers = (r: string): number => nodes.filter((n) => n.region === r && n.status !== 'offline').length;
  const say = !ask
    ? null
    : ask.on
      ? declared.size === 0
        ? `Run ${name} only in ${ask.region}? Its ${copies(each)} move there, and other regions stop running it.`
        : `Also run ${name} in ${ask.region}? ${copies(each)} start there; nothing else moves.`
      : `Stop running ${name} in ${ask.region}? Its ${copies(declared.get(ask.region) ?? 0)} there stop; ${[...declared.keys()].filter((r) => r !== ask.region).join(' and ')} keep serving.`;
  return (
    <div className="flex flex-col gap-2.5">
      <div role="group" aria-label={`Regions ${name} runs in`} className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground mr-1 text-[12.5px]">Run {name} in</span>
        {known.map((r) => {
          const on = declared.has(r);
          const last = on && declared.size === 1;
          return (
            <button
              key={r}
              type="button"
              role="switch"
              aria-checked={on}
              disabled={last || set.isPending}
              title={last ? `${r} is the only region ${name} runs in` : undefined}
              onClick={() => setAsk({ region: r, on: !on })}
              className={cn(
                'inline-flex min-h-9 items-center gap-2 rounded-full border px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed pointer-coarse:min-h-11',
                on ? 'border-primary/60 bg-primary/10 font-semibold' : 'border-border text-muted-foreground hover:text-foreground',
                ask?.region === r && 'ring-2 ring-ring/50',
              )}
            >
              <span aria-hidden className={cn('size-2 rounded-full', on ? 'bg-primary' : 'bg-muted-foreground/30')} />
              {r}
              <span className="text-muted-foreground font-mono text-[10.5px]">{on ? copies(declared.get(r)!) : `${servers(r)} server${servers(r) === 1 ? '' : 's'}`}</span>
            </button>
          );
        })}
      </div>
      {ask && say ? (
        <div role="status" className="bg-surface-2 dark:bg-accent/50 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-3.5 py-2.5">
          <p className="min-w-0 flex-1 basis-64 text-[13.5px]">{say}</p>
          <Button size="sm" disabled={set.isPending} className="pointer-coarse:min-h-11" onClick={() => set.mutate({ serviceId: inv.id, region: ask.region, replicas: ask.on ? each : 0 })}>
            {set.isPending ? 'Saving…' : ask.on ? `Run in ${ask.region}` : `Stop in ${ask.region}`}
          </Button>
          <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" onClick={() => setAsk(null)}>
            Cancel
          </Button>
        </div>
      ) : null}
      <Tech>
        {declared.size
          ? [...declared].map(([r, n]) => `swarmy.region.${r}.replicas=${n}`).join(' · ') + ` · one ${inv.name}-<region> service per region, pinned by node.labels.swarmy.region`
          : `no swarmy.region.<region>.replicas labels on ${inv.name} · placed wherever there's room`}
      </Tech>
    </div>
  );
}
