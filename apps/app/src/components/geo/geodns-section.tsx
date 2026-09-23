import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle, StatusBadge } from '@swarmy/ui';
import { edgeTone } from '@/components/ingress/edge-runtime';
import { useTRPC } from '@/integrations/trpc';
import { GeoDnsControlsCard } from './geodns-controls-card';
import { ZonesCard } from './zones-card';
import { NsOnboardingCard } from './ns-onboarding-card';
import { ResolutionPreviewCard } from './resolution-preview-card';
import { DerivedRecordsCard } from './derived-records-card';
import { ManualRecordsCard } from './manual-records-card';
import { NodeRegionsCard } from './node-regions-card';

const RUNTIME_LABEL: Record<string, string> = {
  paused: 'off',
  deploying: 'starting',
  down: 'down',
  degraded: 'degraded',
  serving: 'live',
};

/**
 * Geo-DNS — "swarmy is the nameserver". Zones are the registrar-facing
 * artifact: point NS records at pinned swarmy nodes and web A records derive
 * from ingress automatically. Full section on the Edge & ingress page.
 */
export function GeoDnsSection(): React.JSX.Element {
  const trpc = useTRPC();
  // Poll: `runtime` is live Docker truth (task errors, per-node push outcome)
  // that converges in the background after enabling.
  const config = useQuery({ ...trpc.geodns.getConfig.queryOptions(), refetchInterval: 5000 });
  const zones = useQuery({ ...trpc.geodns.listZones.queryOptions(), refetchInterval: 10_000 });
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const zoneList = zones.data ?? [];
  const selected = zoneList.find((z) => z.id === selectedId) ?? zoneList[0] ?? null;
  const enabled = !!config.data?.enabled;
  const runtime = config.data?.runtime;
  const showRuntime = enabled && runtime && runtime.state !== 'serving' && runtime.state !== 'paused';

  return (
    <section className="mt-14 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="headline text-2xl">
            swarmy is your <em>nameserver</em>
          </h2>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            Point your registrar at pinned swarmy nodes and every routed domain resolves to the
            nearest healthy region — web records derive from ingress, no zone files to babysit.
          </p>
        </div>
        <StatusBadge
          tone={enabled ? edgeTone(runtime?.state) : 'neutral'}
          label={enabled ? `swarmy-dns · ${RUNTIME_LABEL[runtime?.state ?? 'deploying']}` : 'Off'}
        />
      </div>

      {showRuntime ? (
        <Alert variant={runtime.state === 'deploying' ? 'default' : 'destructive'}>
          <AlertTitle>
            {runtime.state === 'deploying' ? 'swarmy-dns is starting' : 'DNS is not being served'}
          </AlertTitle>
          <AlertDescription>{runtime.message}</AlertDescription>
        </Alert>
      ) : null}

      <GeoDnsControlsCard config={config.data} />

      <ZonesCard
        zones={zoneList}
        selectedId={selected?.id ?? null}
        onSelect={setSelectedId}
      />

      {selected && selected.mode === 'swarmy-ns' ? (
        <NsOnboardingCard zone={selected} nodes={nodes.data ?? []} />
      ) : null}

      <DerivedRecordsCard />

      <div className="grid gap-4 lg:grid-cols-2">
        {selected ? <ResolutionPreviewCard zone={selected} /> : null}
        {selected ? <ManualRecordsCard zone={selected} /> : null}
      </div>

      <NodeRegionsCard nodes={nodes.data ?? []} />
    </section>
  );
}
