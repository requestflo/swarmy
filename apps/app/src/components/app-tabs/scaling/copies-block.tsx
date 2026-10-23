import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InvService } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { Depth, TONE_TEXT, Tech } from '@/components/calm';
import { ServiceScaleStepper } from '@/components/services/service-scale-stepper';
import { useTRPC } from '@/integrations/trpc';
import { countWord } from '../tab-body';
import { copiesHint, type ServerCard } from './strip-model';

/** "Three copies." and why that's enough (or not); the −/+ stepper from Controls. */
export function CopiesBlock({ inv, name, cards }: { inv: InvService; name: string; cards: ServerCard[] | undefined }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const scale = useMutation(
    trpc.services.scale.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );
  const { running, desired } = inv.replicas;
  const global = inv.mode === 'global';
  const asleep = inv.scaleToZero && desired === 0;
  const short = running < desired;
  const sentence = global
    ? 'One copy on every server.'
    : asleep
      ? 'Asleep: no copies until something wakes it.'
      : desired === 0
        ? copiesHint(cards, 0, running, name)
        : `${countWord(desired)} ${desired === 1 ? 'copy' : 'copies'}. ${copiesHint(cards, desired, running, name)}`;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-[13.5px] font-semibold">
        Copies
        <Depth at="controls">
          <span className="text-muted-foreground font-mono text-[11px] font-normal">replicas</span>
        </Depth>
      </h3>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {!global ? (
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
        ) : null}
        <p className="min-w-0 flex-1 basis-56 text-[13.5px] leading-relaxed">
          {sentence}
          {short && !asleep ? <span className={`${TONE_TEXT.warn} font-semibold`}> {running} of {desired} {running === 1 ? 'is' : 'are'} up.</span> : null}
        </p>
      </div>
      <Tech>{`${inv.mode} · replicas: ${desired} · running: ${running}${inv.scaleToZero ? ' · scale-to-zero' : ''}`}</Tech>
    </div>
  );
}
