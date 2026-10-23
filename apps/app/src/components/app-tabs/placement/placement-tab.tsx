import * as React from 'react';
import type { NodeSummary } from '@swarmy/core';
import { CodeView, Depth, SayHeader } from '@/components/calm';
import { CardSkeleton, HeaderSkeleton } from '@/components/states';
import { ServicePicker } from '../scaling/service-picker';
import { pinnedServer, regionOf } from '../scaling/scaling-model';
import type { PlacedService } from '../scaling/use-app-placement';
import { RowsSkeleton, TabBody } from '../tab-body';
import { shortName } from '../use-stack-services';
import { PLACEMENT_NOTE, placementCode } from './placement-code';
import { PlacementSection } from './placement-section';
import { RegionsSection } from './regions-section';
import { usePlacementPage } from './use-placement-page';
import { VolumesSection } from './volumes-section';

/** "api stays on wkr-1; the rest go wherever there's room." */
function PlacementHeader({ stack, rows, nodes }: { stack: string; rows: PlacedService[]; nodes: NodeSummary[] }): React.JSX.Element {
  const pinned = rows
    .map((r) => ({ name: shortName(stack, r.inv.name), server: pinnedServer(r.detail, nodes) }))
    .filter((p) => p.server);
  const regions = new Set(nodes.map(regionOf).filter(Boolean));
  const title =
    pinned.length === 0 ? (
      <>Every part goes wherever there&apos;s room.</>
    ) : (
      <>
        {pinned.map((p) => `${p.name} stays on ${p.server!.name}`).join(', ')}. <em>The rest go wherever there&apos;s room.</em>
      </>
    );
  const where = regions.size > 1 ? `Your servers span ${regions.size} regions.` : regions.size === 1 ? `Every server is in ${[...regions][0]}.` : '';
  return <SayHeader size="md" title={title} lede={`You pick the regions; swarmy picks the servers and keeps copies of one part apart. ${where}`} />;
}

/**
 * Config › Placement & volumes (board AppPlacement): the picked part's
 * regions with the map of where the app's copies run and what that means,
 * then what each part keeps on disk. The raw placement rules are Controls.
 */
export function PlacementTab({ stack }: { stack: string }): React.JSX.Element {
  const page = usePlacementPage(stack);
  const { rows, nodes, picked, declared } = page;
  const ready = rows && nodes;
  return (
    <TabBody
      asideAt="code"
      header={ready ? <PlacementHeader stack={stack} rows={rows} nodes={nodes} /> : <HeaderSkeleton />}
      aside={ready ? <CodeView title="Placement as code" tabs={placementCode(stack, rows, picked?.inv.id, declared)} source="readonly" note={PLACEMENT_NOTE} /> : undefined}
    >
      {ready ? (
        <>
          <ServicePicker stack={stack} rows={rows} value={picked?.inv.id} onChange={page.pick} />
          <RegionsSection stack={stack} page={page} />
          <VolumesSection stack={stack} rows={rows} nodes={nodes} />
          <Depth at="controls">
            <PlacementSection stack={stack} rows={rows} nodes={nodes} />
          </Depth>
        </>
      ) : (
        <>
          <CardSkeleton lines={3} />
          <RowsSkeleton />
        </>
      )}
    </TabBody>
  );
}
