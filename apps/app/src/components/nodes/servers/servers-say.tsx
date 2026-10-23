import * as React from 'react';
import { Say } from '@/components/calm';
import type { Fleet, FleetServer } from './use-fleet';
import { gb } from './server-words';

/** The Servers sentence: how many are online, then the clause that matters (a full disk, one offline, one emptying). */
export function serversTitle(o: { online: number; total: number; fleet: Fleet; down: FleetServer | null; emptying: FleetServer | null }): React.ReactNode {
  const { online, total, fleet, down, emptying } = o;
  return (
    <>
      {total === 0 ? 'No servers yet.' : online === total ? `All ${total} servers are online.` : `${online} of ${total} servers online.`}
      {fleet.hot ? (
        <>
          {' '}
          <Say tone="warn">{fleet.hot.node.name}’s disk is {fleet.hot.diskPct}% full.</Say>
        </>
      ) : down ? (
        <>
          {' '}
          <Say tone="bad">{down.node.name} is offline.</Say>
        </>
      ) : emptying ? (
        <em> {emptying.node.name} is being emptied.</em>
      ) : null}
    </>
  );
}

/** The lede: regions · CPU · memory · price, once the servers answered. */
export function serversLede(fleet: Fleet): string | undefined {
  if (fleet.pending) return undefined;
  return [
    fleet.regions ? `${fleet.regions} region${fleet.regions === 1 ? '' : 's'}` : null,
    `${fleet.cpus} CPU`,
    `${gb(fleet.memBytes)} memory`,
    fleet.monthlyUsd ? `$${fleet.monthlyUsd.toFixed(0)}/mo` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
