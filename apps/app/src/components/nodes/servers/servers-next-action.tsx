import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { NextAction } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { FleetServer } from './use-fleet';
import { gb } from './server-words';

/**
 * RUpkeep's "Tidy up": the fullest server's disk, and the real cleanup run
 * (`nodes.runHygiene` — old images nothing runs, build leftovers, stopped
 * one-off containers; never an image a running service or the previous
 * release uses).
 */
export function TidyUpNext({ server }: { server: FleetServer }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const run = useMutation(
    trpc.nodes.runHygiene.mutationOptions({
      onSuccess: (r) => {
        if (r.ok) toast.success(r.summary);
        else toast.error(r.summary);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const { node, live, diskPct } = server;
  return (
    <NextAction
      title={`Free up space on ${node.name}.`}
      tech={`nodes.runHygiene · prunes stopped containers, unused images, build cache · ${gb(live?.fsUsedBytes)} of ${gb(live?.fsTotalBytes)} used`}
      actions={
        <>
          <Button disabled={run.isPending} onClick={() => run.mutate({ nodeId: node.id })} className="pointer-coarse:min-h-11">
            {run.isPending ? 'Tidying up…' : `Tidy up ${node.name}`}
          </Button>
          <Button asChild variant="ghost" className="pointer-coarse:min-h-11">
            <Link to="/nodes/$nodeId" params={{ nodeId: node.id }}>
              See what's using it
            </Link>
          </Button>
        </>
      }
    >
      Old images nothing runs, build leftovers and finished one-off jobs can go. Your apps keep running, and an
      image that runs in production is never removed.
    </NextAction>
  );
}

/** A server that dropped off: the one thing worth looking at. */
export function OfflineNext({ server }: { server: FleetServer }): React.JSX.Element {
  return (
    <NextAction
      tone="bad"
      title={`${server.node.name} stopped answering.`}
      tech={`status=${server.node.status} · last seen ${server.node.lastSeenAt ?? 'never'}`}
      actions={
        <Button asChild className="pointer-coarse:min-h-11">
          <Link to="/nodes/$nodeId" params={{ nodeId: server.node.id }}>
            Look at {server.node.name}
          </Link>
        </Button>
      }
    >
      Apps that can run elsewhere are moved to your other servers. The server page has the repair line to bring it
      back.
    </NextAction>
  );
}
