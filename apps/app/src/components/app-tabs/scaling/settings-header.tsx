import * as React from 'react';
import type { NodeSummary } from '@swarmy/core';
import { Say, SayHeader } from '@/components/calm';
import { countWord } from '../tab-body';
import { shortName } from '../use-stack-services';
import { pinnedServer, regionOf } from './scaling-model';
import type { PlacedService } from './use-app-placement';

/** "Eleven copies across four services. api stays on wkr-1; the rest go wherever there's room." */
export function SettingsHeader({ stack, rows, nodes }: { stack: string; rows: PlacedService[]; nodes: NodeSummary[] }): React.JSX.Element {
  const total = rows.reduce((n, r) => n + r.inv.replicas.desired, 0);
  const short = rows.filter((r) => r.inv.replicas.running < r.inv.replicas.desired);
  const pinned = rows
    .map((r) => ({ name: shortName(stack, r.inv.name), server: pinnedServer(r.detail, nodes) }))
    .filter((p) => p.server);
  const regions = new Set(nodes.map(regionOf).filter(Boolean));
  const where =
    pinned.length === 0
      ? "They go wherever there's room."
      : `${pinned.map((p) => `${p.name} stays on ${p.server!.name}`).join(', ')}; the rest go wherever there's room.`;
  return (
    <SayHeader
      size="md"
      title={
        <>
          {countWord(total)} {total === 1 ? 'copy' : 'copies'} across {countWord(rows.length, true)} service
          {rows.length === 1 ? '' : 's'}.{' '}
          {short.length ? (
            <Say tone="warn">{shortName(stack, short[0]!.inv.name)} is short a copy.</Say>
          ) : (
            <em>{where}</em>
          )}
        </>
      }
      lede={`More copies means a server can stop without anyone noticing. ${
        regions.size > 1 ? `Your servers span ${regions.size} regions.` : regions.size === 1 ? `Every server is in ${[...regions][0]}.` : ''
      }`}
    />
  );
}
