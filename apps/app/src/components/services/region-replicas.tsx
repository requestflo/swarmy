import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GlobeIcon } from 'lucide-react';
import { Button, Input } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Replicas-per-region (epic #7). Lists the org's known regions and lets you
 * declare N replicas in each; persisted as Docker labels and reconciled to live
 * placement + Geo-DNS capacity. Renders nothing until geo is relevant (the org
 * has region-labelled nodes or the service already declares a region), so it
 * stays out of the way for non-geo services.
 */
export function RegionReplicas({ serviceId }: { serviceId: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useQuery({
    ...trpc.region.get.queryOptions({ serviceId }),
    refetchInterval: 5_000,
  });
  const set = useMutation(
    trpc.region.set.mutationOptions({ onSuccess: () => qc.invalidateQueries() }),
  );

  const data = q.data;
  if (!data || (data.knownRegions.length === 0 && data.regions.length === 0)) return null;

  const declared = new Map(data.regions.map((r) => [r.region, r.replicas] as const));
  const regions = [...new Set([...data.knownRegions, ...declared.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );

  return (
    <div className="border-border rounded-xl border p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <GlobeIcon className="text-status-progress size-4" /> Replicas per region
        </p>
        <span className="mono-data text-muted-foreground text-xs tabular-nums">
          {data.desiredTotal} total
        </span>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        Declared as Docker labels and reconciled to live placement · steers Geo-DNS by capacity.
      </p>
      <ul className="mt-3 space-y-2">
        {regions.map((region) => (
          <RegionRow
            key={region}
            region={region}
            value={declared.get(region) ?? 0}
            pending={set.isPending}
            onApply={(replicas) => set.mutate({ serviceId, region, replicas })}
          />
        ))}
      </ul>
    </div>
  );
}

function RegionRow({
  region,
  value,
  pending,
  onApply,
}: {
  region: string;
  value: number;
  pending: boolean;
  onApply: (replicas: number) => void;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<number>(value);
  React.useEffect(() => {
    setDraft(value);
  }, [value]);
  const dirty = draft !== value;

  return (
    <li className="flex items-center gap-2">
      <span className="mono-label flex-1 truncate">{region}</span>
      <Input
        type="number"
        min={0}
        max={1000}
        aria-label={`Replicas in ${region}`}
        className="mono-data h-8 w-20 tabular-nums"
        value={draft}
        onChange={(e) => setDraft(Math.max(0, Number(e.target.value) || 0))}
      />
      <Button size="sm" variant="outline" disabled={pending || !dirty} onClick={() => onApply(draft)}>
        Apply
      </Button>
    </li>
  );
}
