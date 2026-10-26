import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { wakeTech, wakeWords } from './wake-words';

/**
 * Cold-start time beside Sleep when idle (board AppScaling: "wakes in
 * ~2.1 s"): the median of the wakes the activator timed (`services.wakeTimes`).
 * Shown only while the service sleeps when idle; nothing while it loads.
 */
export function WakeLine({ id, address }: { id: string; address: string | null }): React.JSX.Element | null {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.services.wakeTimes.queryOptions({ id }), refetchInterval: 30_000 });
  const words = wakeWords(q.isError ? null : q.data, address);
  if (!words || !q.data) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-[13.5px] leading-relaxed">{words}</p>
      <Tech>{wakeTech(q.data)}</Tech>
    </div>
  );
}
