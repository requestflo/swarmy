import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NodeSummary } from '@swarmy/core';
import { cn, toast } from '@swarmy/ui';
import { Depth, Section, TONE_DOT, TONE_TEXT, Tech, type Tone } from '@/components/calm';
import { ServiceScaleStepper } from '@/components/services/service-scale-stepper';
import { useTRPC } from '@/integrations/trpc';
import { shortName } from '../use-stack-services';
import { pinnedServer, whereWords } from './scaling-model';
import type { PlacedService } from './use-app-placement';

function copies(n: number): string {
  return `${n} cop${n === 1 ? 'y' : 'ies'}`;
}

/** One row per service: how many copies, where they may run, and (Controls) the −/+ stepper. */
export function CopiesSection({ stack, rows, nodes }: { stack: string; rows: PlacedService[]; nodes: NodeSummary[] }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const scale = useMutation(
    trpc.services.scale.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <Section title="Copies and where they run" count={rows.length} flush>
      <div className="flex flex-col">
        {rows.map(({ inv, detail }) => {
          const { running, desired } = inv.replicas;
          const name = shortName(stack, inv.name);
          const short = running < desired;
          const tone: Tone = desired === 0 ? 'idle' : short ? 'warn' : 'ok';
          return (
            <div key={inv.id} className="border-border flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b px-1 py-2.5 last:border-b-0">
              <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[tone])} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[14.5px] font-semibold">{name}</span>
                  <span className="text-muted-foreground font-mono text-[11.5px]">
                    {desired === 0 ? (inv.scaleToZero ? 'asleep' : 'stopped') : short ? `${running} of ${copies(desired)} up` : copies(desired)}
                  </span>
                </span>
                <span className="text-muted-foreground text-[13px]">
                  {whereWords(detail, nodes)}
                  {desired > 1 && !pinnedServer(detail, nodes) ? ', spread out so one server can stop' : ''}.
                </span>
                <Tech>{detail?.constraints.join(' · ') || `${inv.mode} · no placement rules`}</Tech>
              </span>
              <Depth at="controls">
                <ServiceScaleStepper
                  label={null}
                  name={name}
                  running={running}
                  desired={desired}
                  pending={scale.isPending}
                  onScale={(replicas) => scale.mutate({ id: inv.id, replicas })}
                />
              </Depth>
              <span className={cn('w-20 shrink-0 text-right text-xs font-semibold', TONE_TEXT[tone])}>
                {desired === 0 ? 'Idle' : short ? 'Short a copy' : 'Online'}
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
