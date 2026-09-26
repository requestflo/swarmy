import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DatabaseIcon, EyeIcon, ZapIcon } from 'lucide-react';
import { Button, CopyButton, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { useOnlineNodeCount } from '@/lib/use-online-node-count';

/**
 * Declare a managed-Postgres cluster on this stack. Provisioning never returns
 * the superuser password: it is revealed only on an explicit click, through
 * `db.revealPassword` (policy-gated on `secrets.read` and audited). A stack can hold ANY NUMBER of independent clusters
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
  // Default standby: one copy on a different server once there are 2+ servers
  // (the server applies the same default when replicas is omitted). Follows
  // the nodes query in until the user picks a number; 0 opts out.
  const onlineNodes = useOnlineNodeCount();
  const fitReplicas = onlineNodes !== undefined && onlineNodes >= 2 ? 1 : 0;
  const [replicas, setReplicasState] = React.useState(fitReplicas);
  const touched = React.useRef(false);
  const setReplicas = (n: number): void => {
    touched.current = true;
    setReplicasState(n);
  };
  React.useEffect(() => {
    if (!touched.current) setReplicasState(fitReplicas);
  }, [fitReplicas]);
  const [created, setCreated] = React.useState<{ cluster: string; rwHost: string; roHost: string } | null>(null);
  const [password, setPassword] = React.useState<string | null>(null);

  const trimmed = name.trim();
  const duplicate = existingNames.includes(trimmed);

  const provision = useMutation(
    trpc.db.provision.mutationOptions({
      onSuccess: (res) => {
        toast.success(`Provisioning ${res.cluster} — 1 primary + ${res.replicas} replicas`);
        setCreated({ cluster: res.cluster, rwHost: res.rwHost, roHost: res.roHost });
        setPassword(null);
        setName(hasClusters ? '' : 'main');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const reveal = useMutation(
    trpc.db.revealPassword.mutationOptions({
      onSuccess: (res) => setPassword(res.password),
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="space-y-4">
      {created && (
        <div className="border-primary/40 bg-primary/5 rounded-lg border p-4">
          <div className="flex items-center gap-2">
            <ZapIcon className="text-primary size-4" />
            <p className="text-sm font-medium">
              <code className="mono-data">{created.cluster}</code> is on its way — writes go to{' '}
              <code className="mono-data">{created.rwHost}</code>
            </p>
          </div>
          {password ? (
            <div className="bg-background mt-2 flex items-center justify-between gap-2 rounded-md px-3 py-2">
              <code className="mono-data truncate text-xs">{password}</code>
              <CopyButton value={password} />
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => reveal.mutate({ stack, cluster: created.cluster })}
              disabled={reveal.isPending}
            >
              <EyeIcon className="size-4" /> Reveal superuser password
            </Button>
          )}
          <p className="text-muted-foreground mono-label mt-2">
            Kept in a Docker secret; connected apps read it from there. Revealing it is recorded in the audit log.
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
            variant="outline"
            onClick={() => provision.mutate({ stack, name: trimmed, engine: 'postgres', replicas })}
            disabled={provision.isPending || !trimmed || duplicate}
          >
            <DatabaseIcon className="size-4" /> Provision
          </Button>
        </div>
        {replicas > 0 && (
          <p className="text-muted-foreground mono-label">
            Each standby is a live copy on another server — about {100 * replicas} MB of RAM. Set 0 to skip it.
          </p>
        )}
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
