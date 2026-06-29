import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseIcon, MinusIcon, PlusIcon, ServerIcon, ZapIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CopyButton,
  Input,
  Label,
  StatusBadge,
  type StatusTone,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';

type ClusterStatus = 'running' | 'degraded' | 'deploying' | 'idle' | 'stopped' | 'absent';

function toneFor(status: ClusterStatus): StatusTone {
  if (status === 'running') return 'online';
  if (status === 'degraded') return 'warning';
  if (status === 'deploying') return 'progress';
  if (status === 'absent') return 'offline';
  return 'neutral';
}

/** Read-only host pill with a copy affordance. */
function HostRow({ kind, host }: { kind: 'RW' | 'RO'; host: string }): React.JSX.Element {
  return (
    <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="mono-label text-muted-foreground w-7 shrink-0">{kind}</span>
        <code className="mono-data truncate text-xs">{host}</code>
      </div>
      <CopyButton value={host} />
    </div>
  );
}

/**
 * Stack-level managed-database panel (epic #8).
 *
 * The "magic" surface: declare "postgres, 1 primary + N read replicas" for a
 * stack and swarmy provisions it on the swarm and exposes stable rw/ro hosts —
 * no manual wiring. Shows live primary/replica health, lets you scale replicas
 * with +/- (Docker-truth label, reconciled), and wire an app service to the
 * cluster's DATABASE_URL.
 */
export function ManagedDbPanel({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const topology = useQuery({
    ...trpc.db.get.queryOptions({ stack }),
    refetchInterval: 4_000,
  });
  const clusters = topology.data?.clusters ?? [];

  const [name, setName] = React.useState('main');
  const [replicas, setReplicas] = React.useState(2);
  const [creds, setCreds] = React.useState<{ rwHost: string; roHost: string; password: string } | null>(null);

  const invalidate = () => void qc.invalidateQueries();

  const provision = useMutation(
    trpc.db.provision.mutationOptions({
      onSuccess: (res) => {
        toast.success(`Provisioning ${res.cluster} — 1 primary + ${res.replicas} replicas`);
        setCreds({ rwHost: res.rwHost, roHost: res.roHost, password: res.password });
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const scale = useMutation(
    trpc.db.setReplicas.mutationOptions({
      onSuccess: (res) => {
        toast.success(`${res.cluster} → ${res.replicas} replicas`);
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="card-pop border-0">
      <CardContent className="space-y-6 p-6">
        <div className="flex items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
            <DatabaseIcon className="size-5" />
          </span>
          <div>
            <h3 className="font-semibold leading-tight">Managed databases</h3>
            <p className="text-muted-foreground mono-label">
              Postgres primary/replica · provisioned + wired automatically
            </p>
          </div>
        </div>

        {/* ── Live clusters ─────────────────────────────────────────────── */}
        {clusters.length > 0 && (
          <div className="space-y-4">
            {clusters.map((c) => {
              const pending = scale.isPending && scale.variables?.cluster === c.name;
              const set = (n: number) =>
                scale.mutate({ stack, cluster: c.name, replicas: Math.max(0, n) });
              return (
                <div key={c.name} className="border-border rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <ServerIcon className="text-muted-foreground size-4" />
                      <span className="font-medium">{c.name}</span>
                      <span className="mono-label text-muted-foreground">{c.engine}</span>
                    </div>
                    <StatusBadge tone={toneFor(c.primary.status)} label={c.primary.status} />
                  </div>

                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1">
                      <p className="mono-label text-muted-foreground">Replicas</p>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="icon"
                          aria-label="Remove a replica"
                          disabled={pending || c.replicas.desired <= 0}
                          onClick={() => set(c.replicas.desired - 1)}
                        >
                          <MinusIcon className="size-4" />
                        </Button>
                        <span className="mono-data w-16 text-center text-lg">
                          <CountUp value={c.replicas.running} />
                          <span className="text-muted-foreground"> / {c.replicas.desired}</span>
                        </span>
                        <Button
                          variant="outline"
                          size="icon"
                          aria-label="Add a replica"
                          disabled={pending}
                          onClick={() => set(c.replicas.desired + 1)}
                        >
                          <PlusIcon className="size-4" />
                        </Button>
                        <span className="mono-label text-muted-foreground ml-1">running / desired</span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <HostRow kind="RW" host={c.rwHost} />
                      <HostRow kind="RO" host={c.roHost} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── One-time credentials (shown right after provision) ────────── */}
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

        {/* ── Declare a cluster ─────────────────────────────────────────── */}
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
      </CardContent>
    </Card>
  );
}
