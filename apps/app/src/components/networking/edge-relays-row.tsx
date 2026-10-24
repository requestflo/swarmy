import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Switch, toast } from '@swarmy/ui';
import { StatusWord, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { edgeRelaysSentence, type EdgeRelaysView } from './edge-relays-model';

/**
 * Relays on edges (plans/epic-self-hosted-mesh-and-fleets.md §2.5, M3), inside
 * the control-plane card: a sentence, each edge relay at Controls, one switch.
 */
export function EdgeRelaysRow({ relays, behindEdge }: { relays: EdgeRelaysView; behindEdge: boolean }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const set = useMutation(
    trpc.mesh.control.relays.mutationOptions({
      onSuccess: (_d, v) => {
        toast.success(v.on ? 'Relays are moving to the front doors' : 'Relays are back on the control plane');
        void qc.invalidateQueries();
      },
      onError: (e: { message: string }) => toast.error(e.message),
    }),
  );
  return (
    <div className="grid gap-2">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm">{edgeRelaysSentence(relays)}</p>
        <label className="flex shrink-0 items-center gap-2 text-sm">
          <Switch
            checked={relays.enabled}
            disabled={set.isPending || (!behindEdge && !relays.enabled)}
            onCheckedChange={(on) => set.mutate({ on })}
          />
          Relays on front doors
        </label>
      </div>
      {relays.enabled && relays.edges.length > 0 && (
        <ul className="grid gap-1">
          {relays.edges.map((e) => (
            <li key={e.address} className="flex items-center justify-between gap-3 text-sm">
              <span className="mono-data">{e.hostname}</span>
              <Tech className="min-w-0 flex-1 truncate">{e.address}</Tech>
              <StatusWord tone={e.healthy ? 'ok' : e.running ? 'info' : 'warn'} word={e.healthy ? 'Answering' : e.running ? 'Starting' : 'Not running'} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
