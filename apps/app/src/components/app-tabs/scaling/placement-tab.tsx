import * as React from 'react';
import type { NodeSummary } from '@swarmy/core';
import { CodeView, SayHeader } from '@/components/calm';
import { HeaderSkeleton } from '@/components/states';
import { RowsSkeleton, TabBody } from '../tab-body';
import { shortName } from '../use-stack-services';
import { PlacementSection } from './placement-section';
import { pinnedServer, regionOf, scalingCode } from './scaling-model';
import { useAppPlacement, type PlacedService } from './use-app-placement';
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
  return <SayHeader size="md" title={title} lede={`swarmy keeps copies of one part on different servers where it can. ${where}`} />;
}

/** Config › Placement & volumes (board AppPlacement): where each part may run, and what it keeps on disk. */
export function PlacementTab({ stack }: { stack: string }): React.JSX.Element {
  const { rows, nodes } = useAppPlacement(stack);
  const ready = rows && nodes;
  return (
    <TabBody
      asideAt="code"
      header={ready ? <PlacementHeader stack={stack} rows={rows} nodes={nodes} /> : <HeaderSkeleton />}
      aside={ready ? <CodeView title="Placement as code" tabs={scalingCode(stack, rows)} source="readonly" /> : undefined}
    >
      {ready ? <PlacementSection stack={stack} rows={rows} nodes={nodes} /> : <RowsSkeleton />}
      {ready ? <VolumesSection stack={stack} rows={rows} /> : null}
    </TabBody>
  );
}
