import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MoveRightIcon } from 'lucide-react';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface Manager {
  swarmNodeId: string;
  hostname: string;
  current: boolean;
  blocked: string | null;
}

interface MoveControllerDialogProps {
  managers: Manager[];
  disabled: boolean;
  disabledReason: string | null;
}

/**
 * "Move controller to…": a controlled failover of the control plane. The
 * controller ships its last writes, releases the lease and starts on the
 * chosen manager, which restores from the replica. Gated by `data.failover`.
 */
export function MoveControllerDialog({ managers, disabled, disabledReason }: MoveControllerDialogProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const eligible = managers.filter((m) => !m.blocked);
  const [target, setTarget] = React.useState<string>('');
  const move = useMutation(
    trpc.controllerStore.move.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Moving the controller from ${r.from} to ${r.to}. The dashboard reconnects in about 30 seconds.`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const none = eligible.length === 0;

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled || none} title={disabledReason ?? (none ? 'No other ready manager' : undefined)}>
          <MoveRightIcon className="size-4" /> Move controller to…
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Move the controller to another manager?</AlertDialogTitle>
          <AlertDialogDescription>
            The controller ships its last writes, stops, and starts on the node you pick, which restores
            the store from the replica. Expect about 30 seconds without the dashboard. Your apps keep
            running. The https dashboard address follows the controller. A direct{' '}
            <span className="mono-data">http://&lt;ip&gt;:3021</span> address does not: it answers only on the
            node running the controller, so after the move use the new node&apos;s IP, or better, the https address.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger aria-label="Target manager">
            <SelectValue placeholder="Pick a manager" />
          </SelectTrigger>
          <SelectContent>
            {managers.map((m) => (
              <SelectItem key={m.swarmNodeId} value={m.swarmNodeId} disabled={!!m.blocked}>
                {m.hostname}
                {m.blocked ? ` (${m.blocked})` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <AlertDialogAction disabled={!target || move.isPending} onClick={() => move.mutate({ swarmNodeId: target })}>
            Move controller
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
