import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DatabaseIcon, ZapIcon } from 'lucide-react';
import { Button, CopyButton, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Declare a managed-Postgres cluster on this stack; shows the one-time
 * superuser password. A stack can hold ANY NUMBER of independent clusters
 * (`main`, `analytics`, …) — `existingNames` lets this form reframe itself as
 * "add another" and refuse a name that's already taken.
 */
export function DbDeclareClusterForm({
  stack,
  existingNames = [],
}: {
  stack: string;
  existingNames?: string[];
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const hasClusters = existingNames.length > 0;
  // First database defaults to "main"; once one exists the field starts empty
  // (placeholder-guided) so you name a NEW one instead of re-declaring "main".
  const [name, setName] = React.useState(hasClusters ? '' : 'main');
  const [replicas, setReplicas] = React.useState(2);
  const [creds, setCreds] = React.useState<{ rwHost: string; roHost: string; password: string } | null>(
    null,
  );

  const trimmed = name.trim();
  const duplicate = existingNames.includes(trimmed);

  const provision = useMutation(
    trpc.db.provision.mutationOptions({
      onSuccess: (res) => {
        toast.success(`Provisioning ${res.cluster} — 1 primary + ${res.replicas} replicas`);
        setCreds({ rwHost: res.rwHost, roHost: res.roHost, password: res.password });
        setName(hasClusters ? '' : 'main');
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
        <p className="mono-label text-muted-foreground">
          {hasClusters ? 'Add another database' : 'Declare a database'}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="db-name" className="mono-label">
              Name
            </Label>
            <Input
              id="db-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={hasClusters ? 'analytics' : 'main'}
              className="w-40"
              aria-invalid={duplicate}
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
            onClick={() => provision.mutate({ stack, name: trimmed, engine: 'postgres', replicas })}
            disabled={provision.isPending || !trimmed || duplicate}
          >
            <DatabaseIcon className="size-4" /> Provision
          </Button>
        </div>
        {duplicate ? (
          <p className="text-destructive mono-label">
            <code className="mono-data">{trimmed}</code> already exists in this stack — pick a different name.
          </p>
        ) : (
          <p className="text-muted-foreground mono-label">
            Deploys <code className="mono-data">{stack}_{trimmed || (hasClusters ? 'analytics' : 'main')}-primary</code>{' '}
            + <code className="mono-data">{stack}_{trimmed || (hasClusters ? 'analytics' : 'main')}-replica</code> on
            its own overlay network — independent of {hasClusters ? 'your other databases' : 'anything else'}.
          </p>
        )}
      </div>
    </div>
  );
}
