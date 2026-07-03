import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PauseIcon, PlayIcon, TrashIcon } from 'lucide-react';
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
}

/** Availability (drain/activate) + remove — the destructive end of node control.
 *  Drain and remove are AlertDialog-confirmed; activate is a plain reversible action. */
export function NodeDangerControls({ nodeId, name, status }: NodeDangerControlsProps): React.JSX.Element {
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
