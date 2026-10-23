import * as React from 'react';
import { Button } from '@swarmy/ui';
import type { FleetView } from './fleet/fleet-model';
import { ServiceChip } from './fleet/service-chip';
import { useMove } from './move/move-context';
import { moveStep } from './move/move-rules';

/**
 * What runs on the inspected server, each with its status dot: your
 * services first, swarmy's own parts after. Admins can drag one onto
 * another server on the map, or use "Move…" (the keyboard path).
 */
export function RunningHere({ view }: { view: FleetView | undefined }): React.JSX.Element {
  const m = useMove();
  const services = view?.services;
  if (!view || services === undefined) return <span className="shimmer-line block h-6 w-2/3 rounded-md" />;
  if (services.length === 0) return <p className="text-muted-foreground text-[13px]">Nothing runs here right now.</p>;
  const sorted = [...services].sort((a, b) => Number(a.system) - Number(b.system));
  const fromId = view.server.node.id;
  const movable = services.some((c) => !c.system);
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label={`Running on ${view.server.node.name}`} className="flex flex-col gap-1.5">
        {sorted.map((c) => (
          <ServiceChip key={c.id} chip={c} fromId={fromId}>
            {m.admin && !c.system && !moveStep(c.inv?.labels) ? (
              <Button
                size="sm"
                variant="ghost"
                className="-mr-1.5 h-6 shrink-0 px-2 text-[12px] pointer-coarse:min-h-11"
                aria-label={`Move ${c.short} to another server`}
                onClick={() => m.pick({ chip: c, fromId })}
              >
                Move…
              </Button>
            ) : null}
          </ServiceChip>
        ))}
      </ul>
      {movable && !m.admin ? <p className="text-muted-foreground text-[12.5px]">Only admins and owners can move a service to another server.</p> : null}
    </div>
  );
}
