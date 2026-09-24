import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface ReplicationTargetFormProps {
  replicated: boolean;
  /** 'garage', a BackupTarget id, or null when local-only. */
  currentTargetId: string | null;
}

/**
 * Pick where control.db replicates: swarmy's own Garage (default) or any S3
 * backup target. Saving restarts the controller once (it has to remount its
 * store secret), which the toast says up front.
 */
export function ReplicationTargetForm({ replicated, currentTargetId }: ReplicationTargetFormProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const targets = useQuery(trpc.backups.listTargets.queryOptions());
  const [choice, setChoice] = React.useState<string>(currentTargetId ?? 'garage');
  const s3Targets = (targets.data ?? []).filter((t) => String(t.kind).toLowerCase() === 's3' && t.hasCredentials);

  const done = (msg: string) => {
    toast.success(msg);
    qc.invalidateQueries();
  };
  const enable = useMutation(
    trpc.controllerStore.enableReplication.mutationOptions({
      onSuccess: (r) => done(`Replicating to ${r.target}. The controller restarts once to pick it up.`),
      onError: (e) => toast.error(e.message),
    }),
  );
  const disable = useMutation(
    trpc.controllerStore.disableReplication.mutationOptions({
      onSuccess: (r) => done(`Replication off. The controller is pinned to ${r.pinnedTo} and restarts once.`),
      onError: (e) => toast.error(e.message),
    }),
  );
  const busy = enable.isPending || disable.isPending;
  const save = () =>
    enable.mutate({ target: choice === 'garage' ? { kind: 'garage' } : { kind: 'backup-target', targetId: choice } });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={choice} onValueChange={setChoice}>
        <SelectTrigger className="w-56" aria-label="Replication target">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="garage">Garage (in-swarm)</SelectItem>
          {s3Targets.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" onClick={save} disabled={busy || (replicated && choice === currentTargetId)}>
        {replicated ? 'Switch target' : 'Turn on replication'}
      </Button>
      {replicated ? (
        <Button size="sm" variant="ghost" onClick={() => disable.mutate()} disabled={busy}>
          Keep on this node only
        </Button>
      ) : null}
    </div>
  );
}
