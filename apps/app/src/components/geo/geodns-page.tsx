import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Button, toast } from '@swarmy/ui';
import { SectionHeader } from '@/components/section-header';
import { Depth, NextAction, Say, Section } from '@/components/calm';
import { CardSkeleton, ErrorState } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { useGeoDnsPage } from './use-geodns-page';
import { AskAnywhere } from './ask-anywhere';
import { ZoneRecords } from './zone-records';
import { DelegationSection } from './delegation-section';
import { SteeringSection } from './steering-section';
import { GeoDnsCode } from './geodns-code';
import { GeoDnsControlsCard } from './geodns-controls-card';
import { ZonesCard } from './zones-card';
import { NsOnboardingCard } from './ns-onboarding-card';
import { NodeRegionsCard } from './node-regions-card';
import { zoneModeLabel } from './geo-types';

/**
 * Network › Geo-DNS (board 32): swarmy as the nameserver for a zone — ask
 * from anywhere and see who gets which front door, the zone's records in one
 * table, delegation, and steering. Zones, nameserver picks and server regions
 * are at Controls. `zone` is the `?zone=` pick.
 */
export function GeoDnsPage({ zone: zoneName }: { zone?: string }): React.JSX.Element {
  const g = useGeoDnsPage(zoneName);
  const navigate = useNavigate();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const turnOn = useMutation(trpc.geodns.setEnabled.mutationOptions({ onSuccess: () => void qc.invalidateQueries(), onError: (e) => toast.error(e.message) }));
  const z = g.zone;
  const on = !!g.config?.enabled;
  const rt = g.config?.runtime;
  const trouble = on && rt && rt.state !== 'serving' ? rt.message : null;
  const regions = new Set(g.endpoints.map((e) => e.region)).size;
  const title = !g.ready ? <>Geo-DNS</> : !on ? (
    <>Geo-DNS is off. <em>Every visitor goes to the same front door.</em></>
  ) : !z ? (
    <>swarmy answers for no domain yet. <em>Add one and it sends each visitor to the nearest front door.</em></>
  ) : z.mode !== 'swarmy-ns' ? (
    <>{z.zone} stays with {zoneModeLabel(z.mode)}. <em>swarmy keeps its web records in step there.</em></>
  ) : (
    <>{z.zone} answers from swarmy. {trouble ? <Say tone="warn">{trouble}</Say> : <em>Each visitor gets the nearest healthy front door.</em>}</>
  );
  const lede = z && g.endpoints.length
    ? `${g.endpoints.filter((e) => e.healthy).length} of ${g.endpoints.length} front doors answer, in ${regions} region${regions === 1 ? '' : 's'}. ${z.nameservers.length} nameservers serve ${z.zone}.`
    : undefined;
  const picker = g.zones.length > 1 && z ? (
    <select aria-label="Zone" value={z.zone} onChange={(e) => void navigate({ to: '/network/geo-dns', search: { zone: e.target.value } })} className="border-border bg-background h-9 min-w-44 rounded-[10px] border px-2.5 font-mono text-[13px] pointer-coarse:min-h-11">
      {g.zones.map((x) => <option key={x.id} value={x.zone}>{x.zone}</option>)}
    </select>
  ) : null;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 pb-24 lg:pb-20 xl:px-10">
      <SectionHeader title={title} description={lede} actions={picker} />
      {g.error && !g.ready ? (
        <ErrorState error={g.error} retry={g.retry} />
      ) : !g.ready ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]"><CardSkeleton lines={6} /><CardSkeleton lines={4} /></div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="flex min-w-0 flex-col gap-5">
            {!on ? (
              <NextAction title="Let swarmy answer DNS for your domains" actions={<Button disabled={turnOn.isPending} onClick={() => turnOn.mutate({ enabled: true })}>Turn on geo-DNS</Button>} tech="deploys swarmy-dns on every ingress+outlet server · host network, :53 per address">
                swarmy starts its own nameserver on each front door. Nothing changes for visitors until your registrar points a domain at it.
              </NextAction>
            ) : null}
            {z ? <AskAnywhere key={z.id} zone={z} host={g.askHost} endpoints={g.endpoints} /> : null}
            {z ? <ZoneRecords zone={z} rows={g.rows} records={g.records} ready={g.rowsReady && g.recordsReady} nameOf={g.nameOf} /> : (
              <Section title="Zones"><p className="text-muted-foreground text-[13.5px]">Add your domain as a zone at Controls. swarmy becomes its nameserver and every address under it resolves to the nearest front door.</p></Section>
            )}
            <Depth at="controls">
              <GeoDnsControlsCard config={g.config} />
              <ZonesCard zones={g.zones} selectedId={z?.id ?? null} onSelect={(id) => void navigate({ to: '/network/geo-dns', search: { zone: g.zones.find((x) => x.id === id)?.zone } })} />
              {z && z.mode === 'swarmy-ns' ? <NsOnboardingCard zone={z} nodes={g.nodes} /> : null}
              <NodeRegionsCard nodes={g.nodes} />
            </Depth>
          </div>
          <aside className="flex min-w-0 flex-col gap-4">
            {z ? <GeoDnsCode zone={z} records={g.records} /> : null}
            {z ? <DelegationSection key={z.id} zone={z} /> : null}
            {z ? <SteeringSection zone={z} config={g.config} /> : null}
          </aside>
        </div>
      )}
    </div>
  );
}
