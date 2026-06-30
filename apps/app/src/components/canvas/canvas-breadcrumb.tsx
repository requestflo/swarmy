import * as React from 'react';
import { Panel } from '@xyflow/react';
import { ChevronLeftIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';

interface CanvasBreadcrumbProps {
  /** The drilled-in stack name, or null for the flat "All services" view. */
  stack: string | null;
  onBack: () => void;
}

/**
 * Top-left wayfinding for the service canvas: a back chevron to the stack grid +
 * the current scope ("Stacks / storefront" or "Stacks / All services").
 */
export function CanvasBreadcrumb({ stack, onBack }: CanvasBreadcrumbProps): React.JSX.Element {
  return (
    <Panel position="top-left" className="!m-4">
      <div className="card-pop flex items-center gap-1.5 rounded-full py-1 pr-3.5 pl-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-full"
          onClick={onBack}
          aria-label="Back to stacks"
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        <span className="text-muted-foreground text-xs">Stacks</span>
        <span className="text-muted-foreground/50">/</span>
        <span className="font-display text-[13px] font-bold tracking-tight">
          {stack ?? 'All services'}
        </span>
      </div>
    </Panel>
  );
}
