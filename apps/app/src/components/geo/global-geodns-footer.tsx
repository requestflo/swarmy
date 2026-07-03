import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger, StatusBadge, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { NodeRegionsCard } from './node-regions-card';
import { ZoneConfigCard } from './zone-config-card';
import { ZonePreviewCard } from './zone-preview-card';

/**
 * Org-level Geo-DNS defaults — zone identity, TTL and node regions. Quiet
 * footer on the global Edge & ingress page; per-stack records are the hero
 * and live on each stack's Network tab.
 */
export function GlobalGeoDnsFooter(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const config = useQuery(trpc.geodns.getConfig.queryOptions());
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), enabled: open });
  const preview = useQuery({ ...trpc.geodns.previewZone.queryOptions(), enabled: open && !!config.data?.enabled });

  const enabled = !!config.data?.enabled;
  const invalidate = (): void => void qc.invalidateQueries();

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-10">
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between gap-3 py-2 text-left text-sm font-semibold transition-colors">
        <span className="flex items-center gap-2">
          Geo-DNS defaults
          <StatusBadge tone={enabled ? 'online' : 'neutral'} label={enabled ? 'CoreDNS · live' : 'Off'} />
        </span>
        <ChevronDownIcon className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-4 pt-3 lg:grid-cols-2">
          <ZoneConfigCard
            enabled={enabled}
            initialZone={config.data?.zone ?? ''}
            initialTtl={config.data?.ttl ?? 30}
            onChange={invalidate}
          />
          <ZonePreviewCard enabled={enabled} preview={preview.data} />
        </div>
        <NodeRegionsCard nodes={nodes.data ?? []} onChange={invalidate} />
      </CollapsibleContent>
    </Collapsible>
  );
}
