import * as React from 'react';
import { ChevronDownIcon, SlidersHorizontalIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger, cn } from '@swarmy/ui';
import { DbBackupPanel } from './db-backup-panel';
import { DbTopologySelector } from './db-topology-selector';

interface DbClusterRowDetailProps {
  stack: string;
  cluster: string;
}

/**
 * The deeper cluster controls — topology and backups — folded into the Data
 * tab's cluster row. Lazy: nothing mounts (or fetches) until expanded.
 */
export function DbClusterRowDetail({ stack, cluster }: DbClusterRowDetailProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-4">
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm font-semibold transition-colors">
        <SlidersHorizontalIcon className="size-4" /> Topology & backups
        <ChevronDownIcon className={cn('size-4 transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {open ? (
          <div className="mt-4 grid items-start gap-4 xl:grid-cols-2">
            <DbTopologySelector stack={stack} cluster={cluster} />
            <DbBackupPanel stack={stack} cluster={cluster} />
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
