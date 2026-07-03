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
 */
export function BlueprintCard({ meta, active, onToggle }: BlueprintCardProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'card-pop flex flex-col gap-3 p-5',
        active ? 'ring-primary/40 ring-2' : 'card-pop-hover',
      )}
    >
      <div className="flex items-center gap-3">
        <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
          <BlueprintIcon id={meta.id} className="size-5" />
        </span>
        <h3 className="font-display text-lg font-bold tracking-tight">{meta.name}</h3>
      </div>
      <p className="text-muted-foreground min-h-10 text-sm">{meta.tagline}</p>
      <div className="flex flex-wrap gap-1.5">
        {meta.resources.map((r) => (
          <span key={r} className="mono-label bg-muted rounded-full px-2 py-0.5 text-[10px]">
            {r}
          </span>
        ))}
      </div>
      {meta.docOnly ? (
        <div className="mt-auto pt-1">
          <Button asChild variant="outline" className="rounded-full font-bold">
            <Link to="/observability">
              Open observability <ArrowRightIcon className="size-4" />
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
            <div className="border-border mt-4 border-t pt-4">
              {active ? <BlueprintDeployPanel meta={meta} onClose={() => onToggle(false)} /> : null}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
