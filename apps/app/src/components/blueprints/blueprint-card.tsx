import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, RocketIcon } from 'lucide-react';
import type { BlueprintMetaView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { BlueprintIcon } from './blueprint-icons';

/**
 * One gallery card: icon, name, tagline and resource chips. Deployable cards
 * open the wizard; doc-only cards link to the surface they document.
 */
export function BlueprintCard({
  meta,
  onDeploy,
}: {
  meta: BlueprintMetaView;
  onDeploy: (meta: BlueprintMetaView) => void;
}): React.JSX.Element {
  return (
    <div className="card-pop card-pop-hover flex flex-col gap-3 p-5">
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
      <div className="mt-auto pt-1">
        {meta.docOnly ? (
          <Button asChild variant="outline" className="rounded-full font-bold">
            <Link to="/observability">
              Open observability <ArrowRightIcon className="size-4" />
            </Link>
          </Button>
        ) : (
          <Button
            variant="outline"
            className="rounded-full font-bold"
            onClick={() => onDeploy(meta)}
          >
            <RocketIcon className="size-4" /> Deploy
          </Button>
        )}
      </div>
    </div>
  );
}
