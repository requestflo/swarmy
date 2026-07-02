import * as React from 'react';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { cn } from '../lib/utils';

/**
 * Inline expand/collapse — swarmy's primary disclosure primitive. Prefer this
 * (expanding cards, row-expands) over Dialog/Sheet: the user should never feel
 * blocked by a modal. The only sanctioned modal is AlertDialog for destructive
 * confirms.
 */
export const Collapsible = CollapsiblePrimitive.Root;

export const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger;

export function CollapsibleContent({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      className={cn(
        'overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:slide-in-from-top-1',
        className,
      )}
      {...props}
    />
  );
}
