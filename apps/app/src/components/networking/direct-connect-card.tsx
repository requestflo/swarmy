import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface ConnectResult {
  address: string;
  joinSnippet: string;
  setupKey?: string;
}

/**
 * Direct stack connect (epic #6, Phase 2). Grant an operator/CI peer a
 * point-to-point route to one service over the mesh, gated by an ACL + TTL +
 * audit. Returns a copy-paste join snippet scoped to just that workload. Lists
 * and revokes existing routes.
 */
export function DirectConnectCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const services = useQuery(trpc.services.list.queryOptions({}));
  const routes = useQuery({ ...trpc.mesh.routes.list.queryOptions(), refetchInterval: 15_000 });

  const [serviceId, setServiceId] = React.useState('');
  const [principalId, setPrincipalId] = React.useState('');
  const [port, setPort] = React.useState('');
  const [ttlMin, setTtlMin] = React.useState('60');
  const [result, setResult] = React.useState<ConnectResult | null>(null);

  const grant = useMutation(
    trpc.mesh.routes.grant.mutationOptions({
      onSuccess: (data) => {
        setResult(data.connect);
        toast.success('Direct route granted');
        void qc.invalidateQueries({ queryKey: trpc.mesh.routes.list.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const revoke = useMutation(
    trpc.mesh.routes.revoke.mutationOptions({
      onSuccess: () => {
        toast.success('Route revoked');
        void qc.invalidateQueries({ queryKey: trpc.mesh.routes.list.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const routeList = routes.data ?? [];

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Direct connect</CardTitle>
        <CardDescription>
          Hand a laptop or CI box a direct, audited route to one service over the mesh — hit Postgres
          on its real port, run a migration, attach a debugger. No ingress, no public port.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-1.5">
            <Label className="mono-label">Service</Label>
            <Select value={serviceId} onValueChange={setServiceId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a service" />
              </SelectTrigger>
              <SelectContent>
                {(services.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label" htmlFor="dc-port">
              Port
            </Label>
            <Input id="dc-port" placeholder="5432" value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label" htmlFor="dc-principal">
              Principal (peer/tag)
            </Label>
            <Input
              id="dc-principal"
              placeholder="laptop-calum"
              value={principalId}
              onChange={(e) => setPrincipalId(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label" htmlFor="dc-ttl">
              TTL (minutes)
            </Label>
            <Input id="dc-ttl" placeholder="60" value={ttlMin} onChange={(e) => setTtlMin(e.target.value)} />
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            disabled={grant.isPending || !serviceId || !principalId}
            onClick={() =>
              grant.mutate({
                serviceId,
                principalId,
                port: port ? Number(port) : undefined,
                proto: 'tcp',
                ttlSec: ttlMin ? Number(ttlMin) * 60 : undefined,
              })
            }
          >
            Grant direct route
          </Button>
        </div>

        {result && (
          <div className="ink-block grid gap-2 rounded-xl p-4">
            <span className="mono-label text-ink-foreground/70">Connect to</span>
            <code className="mono-data text-ink-foreground text-sm">{result.address}</code>
            <span className="mono-label text-ink-foreground/70 mt-2">Join the mesh</span>
            <code className="mono-data text-ink-foreground break-all text-xs">{result.joinSnippet}</code>
            <p className="text-ink-foreground/60 mt-1 text-xs">
              Single-use key, short-lived. Scoped by ACL to this service only.
            </p>
          </div>
        )}

        <div className="border-t pt-2">
          <span className="mono-label">Active routes</span>
          {routeList.length === 0 ? (
            <p className="text-muted-foreground py-4 text-sm">No direct routes. Grant one above.</p>
          ) : (
            <div className="mt-2">
              {routeList.map((r) => (
                <div
                  key={r.id}
                  className="hover:bg-accent/60 flex items-center justify-between gap-3 border-b py-3 last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="mono-data truncate text-sm">
                      {r.principalId} → {r.targetServiceId ?? r.targetStackId ?? r.cidr ?? '—'}
                      {r.port ? `:${r.port}` : ''}
                    </p>
                    <p className="text-muted-foreground mono-label">
                      {r.expiresAt ? `expires ${new Date(r.expiresAt).toLocaleString()}` : 'no expiry'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="muted">{r.kind}</Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate({ routeId: r.id })}
                    >
                      Revoke
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
