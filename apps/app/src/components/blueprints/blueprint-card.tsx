import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, RocketIcon, XIcon } from 'lucide-react';
import type { BlueprintMetaView } from '@swarmy/core';
import { Button, cn, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@swarmy/ui';
import { BlueprintIcon } from './blueprint-icons';
import { BlueprintDeployPanel } from './blueprint-deploy-panel';

interface BlueprintCardProps {
  meta: BlueprintMetaView;
  active: boolean;
  onToggle: (open: boolean) => void;
}

/**
 * One gallery card: icon, name, tagline and resource chips. Deployable cards
 * expand in place into the inline deploy wizard (no modal); doc-only cards
 * link to the surface they document. The panel unmounts on collapse so a
 * fresh open always starts at the params form.
 *
 * Width goes to the input: the ACTIVE card spans its whole grid row (the
 * wizard's plan lists hostnames + service names that a one-column card
 * clips), and the wizard itself stays a focused `max-w-2xl` column.
 */
export function BlueprintCard({ meta, active, onToggle }: BlueprintCardProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'card-pop flex min-w-0 flex-col gap-3 p-5',
        active ? 'ring-primary/40 ring-2 sm:col-span-2 xl:col-span-3' : 'card-pop-hover',
      )}
    >
      <div className="flex items-center gap-3">
        <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
          <BlueprintIcon id={meta.id} category={meta.category} className="size-5" />
        </span>
        <h3 className="font-display text-lg font-bold tracking-tight">{meta.name}</h3>
      </div>
      <p className="text-muted-foreground min-h-10 text-sm">{meta.tagline}</p>
      {meta.attribution ? (
        <p className="text-muted-foreground -mt-2 text-[11px]">{meta.attribution}</p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {meta.resources.map((r) => (
          <span key={r} className="mono-label bg-muted rounded-full px-2 py-0.5 text-[10px]">
            {r}
          </span>
        ))}
        {meta.heavy ? (
          <span
            title={meta.heavyReason}
            className="mono-label bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px]"
          >
            {meta.minMemoryMb ? `~${Math.ceil(meta.minMemoryMb / 256) / 4} GB RAM` : 'Heavy'}
          </span>
        ) : null}
      </div>
      {meta.docOnly ? (
        <div className="mt-auto pt-1">
          <Button asChild variant="outline" className="rounded-full font-bold">
            <Link to="/">
              Open a stack → Observability <ArrowRightIcon className="size-4" />
            </Link>
          </Button>
        </div>
      ) : (
        <Collapsible open={active} onOpenChange={onToggle} className="mt-auto">
          <div className="pt-1">
            <CollapsibleTrigger asChild>
              <Button variant="outline" className="rounded-full font-bold">
                {active ? (
                  <>
                    <XIcon className="size-4" /> Close
                  </>
                ) : (
                  <>
                    <RocketIcon className="size-4" /> Deploy
                  </>
                )}
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div className="border-border mt-4 min-w-0 max-w-2xl border-t pt-4">
              {active ? <BlueprintDeployPanel meta={meta} onClose={() => onToggle(false)} /> : null}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
