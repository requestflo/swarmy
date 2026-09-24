import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRightIcon } from 'lucide-react';
import { StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** This stack's managed caches as studio entry points (queue caches first). */
export function QueueClustersStrip({ stack }: { stack: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const clusters = useQuery({ ...trpc.queues.studioClusters.queryOptions({ stack }), refetchInterval: 15_000 });
  const rows = clusters.data ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {rows.map((c) => (
        <Link
          key={c.cluster}
          to="/stacks/$name/queues/$cluster"
          params={{ name: stack, cluster: c.cluster }}
          className="border-border hover:bg-muted/30 flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm"
        >
          <span className="mono-data font-semibold">{c.cluster}</span>
          <StatusBadge
            tone={!c.online ? 'offline' : c.purpose === 'queue' ? 'online' : 'neutral'}
            label={!c.online ? 'down' : c.purpose === 'queue' ? 'queue' : 'cache'}
          />
          <span className="text-muted-foreground text-xs">Open studio</span>
          <ArrowUpRightIcon className="text-muted-foreground size-3.5" />
        </Link>
      ))}
    </div>
  );
}
