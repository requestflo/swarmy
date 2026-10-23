import * as React from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { FleetGroup } from '../fleet/fleet-model';
import { useMove } from './move-context';

/**
 * `/nodes?move=<serviceId>` — "Move…" from another page (an app's Placement
 * & volumes): once the fleet map knows where the service runs, inspect that
 * server and open the move picker for it, as the inspector's own "Move…"
 * does. Non-admins land on the server (the inspector says who can move).
 */
export function useMoveFromSearch(groups: FleetGroup[] | undefined, inspect: (nodeId: string) => void): void {
  const { move } = useSearch({ strict: false }) as { move?: string };
  const m = useMove();
  const navigate = useNavigate();
  const seen = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!move || !groups) return;
    for (const g of groups) {
      for (const v of g.servers) {
        const chip = v.services?.find((c) => c.id === move || c.name === move);
        if (!chip) continue;
        if (seen.current !== move) {
          seen.current = move;
          inspect(v.server.node.id);
        }
        if (m.admin && m.stage === 'idle') {
          m.pick({ chip, fromId: v.server.node.id });
          void navigate({ to: '/nodes', search: {}, replace: true });
        }
        return;
      }
    }
  }, [move, groups, m, inspect, navigate]);
}
