import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronsDownIcon, ChevronsUpIcon, PauseIcon, PlayIcon, TrashIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  toast,
} from '@swarmy/ui';
import type { NodeStatusView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

interface NodeDangerControlsProps {
  nodeId: string;
  name: string;
  status: NodeStatusView | undefined;
  /** Live swarm role — drives promote/demote (WS2). Omitted = hide the control. */
  role?: 'manager' | 'worker';
}

/** Availability (drain/activate), promote/demote, + remove — the destructive end
 *  of node control. Drain, demote and remove are AlertDialog-confirmed; activate
 *  and promote are plain reversible actions. Demote is quorum-guarded server-side. */
export function NodeDangerControls({ nodeId, name, status, role }: NodeDangerControlsProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const draining = status === 'draining';

  const drain = useMutation(
    trpc.nodes.drain.mutationOptions({
      onSuccess: () => {
        toast.success(`${name} is draining`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const activate = useMutation(
    trpc.nodes.activate.mutationOptions({
      onSuccess: () => {
        toast.success(`${name} activated`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const promote = useMutation(
    trpc.swarm.promote.mutationOptions({
      onSuccess: () => {
        toast.success(`${name} promoted to manager`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const demote = useMutation(
    trpc.swarm.demote.mutationOptions({
      onSuccess: () => {
        toast.success(`${name} demoted to worker`);
        void qc.invalidateQueries();
      },
      // The server's quorum guard speaks plainly — surface it verbatim.
      onError: (e) => toast.error(e.message),
    }),
  );
  const remove = useMutation(
    trpc.nodes.remove.mutationOptions({
      onSuccess: () => {
        toast.success(`${name} removed`);
        void qc.invalidateQueries();
        void navigate({ to: '/nodes' });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2">
        {draining ? (
          <Button
            variant="outline"
            disabled={activate.isPending}
            onClick={() => activate.mutate({ id: nodeId })}
          >
            <PlayIcon className="size-4" /> Activate
          </Button>
        ) : (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={drain.isPending}>
                <PauseIcon className="size-4" /> Drain
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Drain {name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Every task on this node is rescheduled elsewhere in the swarm. The node stays
                  enrolled and can be reactivated at any time.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => drain.mutate({ id: nodeId })}>
                  Drain node
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {role === 'worker' ? (
          <Button
            variant="outline"
            disabled={promote.isPending}
            onClick={() => promote.mutate({ id: nodeId })}
          >
            <ChevronsUpIcon className="size-4" /> Promote to manager
          </Button>
        ) : null}
        {role === 'manager' ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={demote.isPending}>
                <ChevronsDownIcon className="size-4" /> Demote to worker
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Demote {name} to worker?</AlertDialogTitle>
                <AlertDialogDescription>
                  {name} stops voting in the manager quorum and can no longer run control-plane
                  commands. swarmy refuses the demote if it would break quorum.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => demote.mutate({ id: nodeId })}>
                  Demote node
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" disabled={remove.isPending}>
            <TrashIcon className="size-4" /> Remove node
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes {name}'s enrollment record. If it's still running Docker, leave the swarm
              on the host first — otherwise it may rejoin as an unknown node.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate({ id: nodeId })}>
              Remove node
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
