import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, ExternalLinkIcon } from 'lucide-react';
import type { BlueprintMetaView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { AlreadyOn, Tech } from '@/components/calm';
import { BlueprintIcon } from './blueprint-icons';
import { BlueprintDeployPanel } from './blueprint-deploy-panel';
import { memoryLabel, youGet } from './template-words';

/**
 * Configure (canvas "Configure"): the picked template, what you get, and the
 * deploy steps — name + address prefilled, passwords generated, size and
 * options at Controls, a review of the exact plan, then the result.
 */
export function TemplateConfigure({
  meta,
  onClose,
}: {
  meta: BlueprintMetaView;
  onClose: () => void;
}): React.JSX.Element {
  const mem = memoryLabel(meta);
  return (
    <section aria-label={`Configure ${meta.name}`} className="calm-card flex flex-col gap-4 px-5 py-5">
      <div className="flex items-start gap-3">
        <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
          <BlueprintIcon id={meta.id} category={meta.category} className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="font-display text-[1.35rem] leading-tight font-bold tracking-[-0.02em]">{meta.name}</h2>
          <p className="text-muted-foreground text-[13px]">{meta.tagline}</p>
          <Tech>{[meta.version && `v${meta.version}`, meta.category, mem].filter(Boolean).join(' · ')}</Tech>
        </div>
      </div>
      {meta.docOnly ? (
        <>
          <p className="text-muted-foreground text-[13.5px]">Nothing to deploy: this is already built into every app.</p>
          <Button asChild variant="outline" className="w-fit">
            <Link to="/">
              Open an app <ArrowRightIcon className="size-4" />
            </Link>
          </Button>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <h3 className="calm-eyebrow">You get</h3>
            <AlreadyOn bare items={youGet(meta)} />
          </div>
          <div className="border-border border-t pt-4">
            <BlueprintDeployPanel key={meta.id} meta={meta} onClose={onClose} />
          </div>
          {meta.postDeploy?.length ? (
            <div className="flex flex-col gap-1.5">
              <h3 className="calm-eyebrow">After it's live</h3>
              <ol className="text-muted-foreground list-decimal pl-5 text-[13px] leading-relaxed">
                {meta.postDeploy.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
          ) : null}
        </>
      )}
      {meta.attribution || meta.website ? (
        <p className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
          {meta.attribution ? <span>{meta.attribution}</span> : null}
          {meta.website ? (
            <a href={meta.website} target="_blank" rel="noreferrer" className="hover:text-foreground inline-flex items-center gap-1 underline-offset-2 hover:underline">
              Project site <ExternalLinkIcon aria-hidden className="size-3" />
            </a>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
