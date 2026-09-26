import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import type { BlueprintMetaView } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { CreatesGraph } from '@/components/blueprints/creates-graph';
import { graphModel } from '@/components/blueprints/creates-model';
import { LetterAvatar } from '@/components/blueprints/letter-avatar';
import { categoryLabel, memoryLabel } from '@/components/blueprints/template-words';
import { useTemplatePlan } from '@/components/blueprints/use-template-plan';
import { gb } from '@/components/nodes/servers/server-words';
import { fitsIn, useServerRoom } from './use-server-room';

function Fact({ label, children, tone }: { label: string; children: React.ReactNode; tone?: 'ok' | 'warn' }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('text-right font-mono text-[12.5px]', tone === 'ok' && 'text-tone-ok', tone === 'warn' && 'text-tone-warn')}>{children}</dd>
    </div>
  );
}

/** The hub aside (board 2): the picked template, what it creates, whether it fits, and the one coral step on. */
export function DeployTemplateAside({ meta }: { meta: BlueprintMetaView }): React.JSX.Element {
  const plan = useTemplatePlan(meta);
  const room = useServerRoom();
  const top = room.roomiest;
  const secrets = plan.data ? plan.data.steps.some((s) => s.kind === 'secret' || s.kind === 'db.provision') : meta.resources.includes('Secret');
  return (
    <section aria-label={meta.name} className="calm-card flex flex-col gap-4 px-5 py-5">
      <div className="flex items-center gap-3">
        <LetterAvatar id={meta.id} name={meta.name} size="lg" />
        <div className="flex min-w-0 flex-col">
          <h2 className="font-display text-[1.45rem] leading-tight font-bold tracking-[-0.02em]">{meta.name}</h2>
          <span className="text-muted-foreground text-[13px]">{categoryLabel(meta)}</span>
        </div>
      </div>
      <p className="text-muted-foreground line-clamp-2 text-[13.5px] leading-relaxed">{meta.tagline}</p>
      <div className="flex flex-col gap-2">
        <h3 className="calm-eyebrow">What gets created</h3>
        <CreatesGraph model={graphModel(meta, { plan: plan.data })} />
      </div>
      <dl className="flex flex-col gap-1.5">
        {meta.minMemoryMb ? <Fact label="Memory">{memoryLabel(meta)}</Fact> : null}
        {top && meta.minMemoryMb ? (
          fitsIn(meta.minMemoryMb, top.freeBytes) ? (
            <Fact label={`Fits on ${top.name}`} tone="ok">yes · {gb(top.freeBytes)} free</Fact>
          ) : (
            <Fact label={`Fits on ${top.name}`} tone="warn">won’t fit · {gb(top.freeBytes)} free</Fact>
          )
        ) : null}
        <Fact label="Secrets">{secrets ? 'generated for you' : 'none needed'}</Fact>
      </dl>
      <div className="flex flex-col gap-2 pt-1">
        <Button asChild size="lg" className="w-full pointer-coarse:min-h-11">
          <Link to="/deploy/$template" params={{ template: meta.id }}>
            Configure {meta.name} <ArrowRightIcon className="size-4" />
          </Link>
        </Button>
        <p className="text-muted-foreground text-center text-xs">Next: name and address. Nothing runs until you press Deploy.</p>
      </div>
    </section>
  );
}
