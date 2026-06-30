import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GlobeIcon } from 'lucide-react';
import { Button, Input, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Multi-region plan editor (epic #7) for a logical app.
 *
 * Declares "how many replicas in each region" — persisted Docker-direct as
 * `swarmy.region.<region>.replicas` labels and reconciled by the worker into one
 * `<name>-<region>` sibling per region — and surfaces the live materialisation
 * (declared *desired* vs *running* siblings) so the canvas frame's region badges
 * have a place to be tuned. Renders nothing until geo is relevant (the org has
 * region-labelled nodes, or the service already declares/materialises a region),
 * so it stays out of the way for single-region apps.
 */
export function RegionPlanEditor({ serviceId }: { serviceId: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const declared = useQuery({
    ...trpc.region.get.queryOptions({ serviceId }),
    refetchInterval: 5_000,
  });
  const plan = useQuery({
    ...trpc.region.plan.queryOptions({ serviceId }),
    refetchInterval: 5_000,
  });

  const set = useMutation(
    trpc.region.set.mutationOptions({
      onSuccess: (_res, vars) => {
        toast.success(
          vars.replicas > 0
            ? `${vars.region} → ${vars.replicas} ${vars.replicas === 1 ? 'replica' : 'replicas'}`
            : `${vars.region} cleared`,
        );
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const data = declared.data;
  if (!data || (data.knownRegions.length === 0 && data.regions.length === 0)) return null;

  const declaredByRegion = new Map(data.regions.map((r) => [r.region, r.replicas] as const));
  const runningByRegion = new Map((plan.data ?? []).map((p) => [p.region, p.running] as const));
  // Every region in play: known (node labels) ∪ declared (intent) ∪ materialised.
  const regions = [
    ...new Set([
      ...data.knownRegions,
      ...declaredByRegion.keys(),
      ...runningByRegion.keys(),
    ]),
  ].sort((a, b) => a.localeCompare(b));

  const runningTotal = (plan.data ?? []).reduce((sum, p) => sum + p.running, 0);

  return (
    <div className="border-border rounded-xl border p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <GlobeIcon className="text-status-progress size-4" /> Multi-region
        </p>
        <span className="mono-data text-muted-foreground text-xs tabular-nums">
          {runningTotal}/{data.desiredTotal} up
        </span>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        Declared as Docker labels and reconciled into one sibling per region · steers Geo-DNS by
        capacity.
      </p>
      <ul className="mt-3 space-y-2">
        {regions.map((region) => (
          <RegionRow
            key={region}
            region={region}
            desired={declaredByRegion.get(region) ?? 0}
            running={runningByRegion.get(region) ?? 0}
            pending={set.isPending && set.variables?.region === region}
            onApply={(replicas) => set.mutate({ serviceId, region, replicas })}
          />
        ))}
      </ul>
    </div>
  );
}

/** Status dot for a region: live when running covers desired; idle when desired is 0. */
function regionTone(desired: number, running: number): string {
  if (desired === 0) return 'idle';
  if (running >= desired) return 'online';
  if (running === 0) return 'progress';
  return 'warning';
}

/**
 * One region row: a desired-vs-running health readout plus an editable replica
 * count. The input is a local draft so a 5s poll never clobbers mid-edit; Apply is
 * enabled only when the draft diverges from the declared (Docker-truth) value.
 */
function RegionRow({
  region,
  desired,
  running,
  pending,
  onApply,
}: {
  region: string;
  desired: number;
  running: number;
  pending: boolean;
  onApply: (replicas: number) => void;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<number>(desired);
  React.useEffect(() => {
    setDraft(desired);
  }, [desired]);
  const dirty = draft !== desired;
  const tone = regionTone(desired, running);

  return (
    <li className="flex items-center gap-2">
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ background: `var(--status-${tone})` }}
        />
        <span className="mono-label truncate">{region}</span>
        <span className="mono-data text-muted-foreground ml-1 text-[10px] tabular-nums">
          {running}/{desired} up
        </span>
      </span>
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
