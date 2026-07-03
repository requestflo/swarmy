import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { BracesIcon, ChevronDownIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface ServiceDefinitionSectionProps {
  serviceId: string;
}

/**
 * Raw `docker service inspect` — the complete spec + task/update status for
 * one service. Folded into a collapsible section inside the docked inspector
 * (never a modal); fetches lazily, only once expanded.
 */
export function ServiceDefinitionSection({ serviceId }: ServiceDefinitionSectionProps): React.JSX.Element {
  const trpc = useTRPC();
  const [open, setOpen] = React.useState(false);
  const inspect = useQuery({
    ...trpc.services.inspect.queryOptions({ id: serviceId }),
    enabled: open,
  });

  const json = inspect.data ? JSON.stringify(inspect.data, null, 2) : '';

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-border rounded-xl border">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 p-3 text-left">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <BracesIcon className="size-4" /> Definition
        </span>
        <ChevronDownIcon className={cn('text-muted-foreground size-4 transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="bg-muted/30 border-border mx-3 mb-3 max-h-72 overflow-auto rounded-lg border p-3">
          {inspect.isLoading && <p className="text-muted-foreground text-sm">Loading inspect…</p>}
          {inspect.isError && (
            <p className="text-status-offline text-sm">Failed to inspect: {inspect.error.message}</p>
          )}
          {!inspect.isLoading && !inspect.isError && (
            <pre className="mono-data text-xs break-all whitespace-pre-wrap">{json}</pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
