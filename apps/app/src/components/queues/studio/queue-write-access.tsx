import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';

/**
 * "writes need data.write · you have it" — the studio's retry/promote/pause are
 * gated on `data.write` (remove and clean on `data.destroy`). The check is the
 * policy simulator for you, workspace-wide; a grant on just this app can still
 * let a write through.
 */
export function QueueWriteAccess(): React.JSX.Element | null {
  const trpc = useTRPC();
  const sim = useQuery({ ...trpc.policies.simulate.queryOptions({ action: 'data.write' }), staleTime: 60_000, retry: false });
  if (!sim.data) return null;
  return (
    <Tech>
      writes need data.write · {sim.data.decision === 'permit' ? 'you have it' : 'not granted to you workspace-wide'} · remove and
      clean need data.destroy
    </Tech>
  );
}
