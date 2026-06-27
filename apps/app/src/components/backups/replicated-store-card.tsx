import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Replicated object store (Garage) status + enable/disable. Advanced, off by
 * default — mirrors the ingress driver UX. Backup targets can point restic at
 * the in-swarm endpoint once enabled.
 */
export function ReplicatedStoreCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const config = useQuery(trpc.storage.getConfig.queryOptions());
  const status = useQuery(trpc.storage.status.queryOptions());

  const setDriver = useMutation(
    trpc.storage.setDriver.mutationOptions({
      onSuccess: () => qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );
  const enable = useMutation(
    trpc.storage.enable.mutationOptions({
      onSuccess: () => {
        toast.success('Replicated store enabled');
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const disable = useMutation(
    trpc.storage.disable.mutationOptions({
      onSuccess: () => {
        toast.success('Replicated store disabled');
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const cfg = config.data;
  const members = status.data?.members ?? [];
  const isEnabled = Boolean(cfg?.enabled);

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          Replicated object store
          <StatusBadge
            tone={isEnabled ? 'online' : 'neutral'}
            label={isEnabled ? 'enabled' : 'off'}
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-muted-foreground text-sm">
          A swarmy-managed Garage S3 cluster replicated across your nodes. Off any single node — any
          node can run the app. Use it as a backup target for off-node durability.
        </p>
        <div className="text-sm">
          <span className="mono-label text-muted-foreground">driver</span>{' '}
          <Badge variant="muted">{cfg?.driver ?? 'none'}</Badge>{' '}
          <span className="mono-label text-muted-foreground">replication</span> x
          {cfg?.replicationFactor ?? 3}
          {cfg?.endpoint ? (
            <>
              {' '}
              <span className="mono-label text-muted-foreground">endpoint</span>{' '}
              <code className="text-xs">{cfg.endpoint}</code>
            </>
          ) : null}
        </div>
        {members.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {members.map((m) => (
              <Badge key={m.nodeId} variant={m.online ? 'default' : 'muted'}>
                {m.nodeId.slice(0, 8)} · {m.online ? 'online' : 'offline'}
              </Badge>
            ))}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          {!isEnabled ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={setDriver.isPending}
                onClick={() => setDriver.mutate({ driver: 'garage' })}
              >
                Configure Garage
              </Button>
              <Button
                size="sm"
                disabled={enable.isPending || cfg?.driver !== 'garage'}
                onClick={() => enable.mutate()}
              >
                Enable
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={disable.isPending}
              onClick={() => disable.mutate()}
            >
              Disable
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
