import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { BlueprintMetaView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { CreatesGraph } from './creates-graph';
import { graphModel } from './creates-model';
import { FitsServers } from './fits-servers';
import { LetterAvatar } from './letter-avatar';
import { PlanSteps } from './plan-steps';
import { TemplateCode } from './template-code';
import { categoryLabel } from './template-words';
import { useTemplatePlan } from './use-template-plan';

/**
 * The Templates aside (board 53): the picked app, what it creates (the dry-run
 * steps at Controls), whether it fits each server, what to do once it's live,
 * and the one coral step on to Configure.
 */
export function TemplateAside({ meta }: { meta: BlueprintMetaView }): React.JSX.Element {
  const plan = useTemplatePlan(meta);
  return (
    <div className="flex flex-col gap-4">
      <TemplateCode meta={meta} />
      <section aria-label={meta.name} className="calm-card flex flex-col gap-4 px-5 py-5">
        <div className="flex items-start gap-3">
          <LetterAvatar id={meta.id} name={meta.name} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="font-display text-[1.35rem] leading-tight font-bold tracking-[-0.02em]">{meta.name}</h2>
            <span className="text-muted-foreground font-mono text-[11.5px]">
              {[meta.version && `v${meta.version}`, categoryLabel(meta)].filter(Boolean).join(' · ')}
            </span>
          </div>
          {meta.heavy ? (
            <span className="bg-status-warning/15 text-tone-warn rounded-md px-1.5 py-0.5 text-[11px] font-semibold">heavy</span>
          ) : null}
        </div>
        <p className="text-muted-foreground text-[13.5px] leading-relaxed">{meta.tagline}</p>
        <div className="flex flex-col gap-2">
          <h3 className="calm-eyebrow">What it creates</h3>
          <CreatesGraph model={graphModel(meta, { plan: plan.data, host: plan.data?.autoHost })} />
          <Depth at="controls">
            {plan.data ? <PlanSteps steps={plan.data.steps} /> : plan.isPending ? <div className="shimmer-line h-16 rounded" /> : null}
          </Depth>
        </div>
        <FitsServers meta={meta} />
        {meta.postDeploy?.length ? (
          <div className="flex flex-col gap-1.5">
            <h3 className="calm-eyebrow">After it's live</h3>
            <ol className="flex flex-col gap-1 text-[13px] leading-relaxed">
              {meta.postDeploy.map((s, i) => (
                <li key={s} className="flex gap-2">
                  <span className="text-muted-foreground font-mono">{i + 1}</span>
                  <span>{s.replaceAll('<url>', 'the app’s address')}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {meta.attribution ? <p className="text-muted-foreground font-mono text-[11px]">{meta.attribution}</p> : null}
        <Button asChild size="lg" className="w-full pointer-coarse:min-h-11">
          <Link to="/deploy/$template" params={{ template: meta.id }}>
            Deploy {meta.name}
          </Link>
        </Button>
      </section>
    </div>
  );
}
