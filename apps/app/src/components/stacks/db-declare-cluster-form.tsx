import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DatabaseIcon, ZapIcon } from 'lucide-react';
import { Button, CopyButton, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Declare a new managed-Postgres cluster on this stack; shows the one-time superuser password. */
export function DbDeclareClusterForm({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = React.useState('main');
  const [replicas, setReplicas] = React.useState(2);
  const [creds, setCreds] = React.useState<{ rwHost: string; roHost: string; password: string } | null>(
    null,
  );

  const provision = useMutation(
    trpc.db.provision.mutationOptions({
      onSuccess: (res) => {
        toast.success(`Provisioning ${res.cluster} — 1 primary + ${res.replicas} replicas`);
        setCreds({ rwHost: res.rwHost, roHost: res.roHost, password: res.password });
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="space-y-4">
      {creds && (
        <div className="border-primary/40 bg-primary/5 rounded-lg border p-4">
          <div className="flex items-center gap-2">
            <ZapIcon className="text-primary size-4" />
            <p className="text-sm font-medium">Superuser password (shown once)</p>
          </div>
          <div className="bg-background mt-2 flex items-center justify-between gap-2 rounded-md px-3 py-2">
            <code className="mono-data truncate text-xs">{creds.password}</code>
            <CopyButton value={creds.password} />
          </div>
          <p className="text-muted-foreground mono-label mt-2">
            Stored only in Docker (service env). Copy it now.
          </p>
        </div>
      )}

      <div className="border-border space-y-3 border-t pt-5">
        <p className="mono-label text-muted-foreground">Declare a cluster</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="db-name" className="mono-label">
              Name
            </Label>
            <Input
              id="db-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="main"
              className="w-40"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="db-replicas" className="mono-label">
              Read replicas
            </Label>
            <Input
              id="db-replicas"
              type="number"
              min={0}
              max={20}
              value={replicas}
              onChange={(e) => setReplicas(Number(e.target.value))}
              className="w-28"
            />
          </div>
          <Button
            onClick={() => provision.mutate({ stack, name, engine: 'postgres', replicas })}
            disabled={provision.isPending || !name.trim()}
          >
            <DatabaseIcon className="size-4" /> Provision
          </Button>
        </div>
        <p className="text-muted-foreground mono-label">
          Deploys <code className="mono-data">{stack}_{name || 'main'}-primary</code> +{' '}
          <code className="mono-data">{stack}_{name || 'main'}-replica</code> on a per-cluster
          overlay network.
        </p>
      </div>
    </div>
  );
}
