import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
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
export function ReplicatedStorePanel(): React.JSX.Element {
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
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="min-w-0">
          <CardTitle className="text-base">Replicated object store</CardTitle>
          <CardDescription>
            A swarmy-managed Garage S3 cluster, replicated across your nodes — off-node durability
            for any backup target.
          </CardDescription>
        </div>
        <StatusBadge tone={isEnabled ? 'online' : 'neutral'} label={isEnabled ? 'enabled' : 'off'} />
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
          <Stat label="Driver" value={cfg?.driver ?? 'none'} />
          <Stat label="Replication" value={`x${cfg?.replicationFactor ?? 3}`} />
          <Stat label="Members" value={`${members.length}`} />
        </div>

        {cfg?.endpoint ? (
          <div>
            <p className="mono-label text-muted-foreground">Endpoint</p>
            <code className="mono-data text-xs">{cfg.endpoint}</code>
          </div>
        ) : null}

        {members.length > 0 ? (
          <div>
            <p className="mono-label text-muted-foreground mb-2">Cluster members</p>
            <div className="flex flex-wrap gap-2">
              {members.map((m) => (
                <StatusBadge
                  key={m.nodeId}
                  tone={m.online ? 'online' : 'offline'}
                  label={`${m.nodeId.slice(0, 8)} · ${m.online ? 'online' : 'offline'}`}
                />
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
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

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <p className="mono-label text-muted-foreground">{label}</p>
      <p className="mono-data truncate text-lg font-semibold">{value}</p>
    </div>
  );
}
