import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@swarmy/ui';
import { Depth, Section, StatusWord, Tech, toneFromStatus } from '@/components/calm';
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
 * from ingress automatically. Summary sentence on the Network hub; the
 * knobs at Controls.
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

  const swarmyZones = zoneList.filter((z) => z.mode === 'swarmy-ns').length;
  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Nearest front door"
        hint="Geo-DNS"
        action={
          <StatusWord
            tone={enabled ? toneFromStatus(edgeTone(runtime?.state)) : 'idle'}
            word={enabled ? `DNS ${RUNTIME_LABEL[runtime?.state ?? 'deploying']}` : 'Off'}
          />
        }
      >
        <p className="text-muted-foreground text-[13.5px] leading-relaxed">
          {enabled
            ? `swarmy answers for ${swarmyZones} domain${swarmyZones === 1 ? '' : 's'} itself and sends each visitor to the closest healthy front door.`
            : 'Off. Every visitor goes to the same front door. Turn it on to answer for your domains and send visitors to the closest one.'}
        </p>
        <Tech>swarmy-dns on ingress+outlet servers · web records derive from routes · no zone files</Tech>
      </Section>

      {showRuntime ? (
        <Alert variant={runtime.state === 'deploying' ? 'default' : 'destructive'}>
          <AlertTitle>
            {runtime.state === 'deploying' ? 'swarmy-dns is starting' : 'DNS is not being served'}
          </AlertTitle>
          <AlertDescription>{runtime.message}</AlertDescription>
        </Alert>
      ) : null}

      <Depth at="controls">
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

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        {selected ? <ResolutionPreviewCard zone={selected} /> : null}
        {selected ? <ManualRecordsCard zone={selected} /> : null}
      </div>

      <NodeRegionsCard nodes={nodes.data ?? []} />
      </Depth>
    </div>
  );
}
