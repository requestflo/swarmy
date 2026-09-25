import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/**
 * Networking → Mesh → the control plane that runs in swarmy
 * (plans/epic-self-hosted-mesh-and-fleets.md §2.7): "Runs in swarmy on lon-1 ·
 * NetBird v0.79.0 · backed up · 14 peers", with Move / Break-glass / Sync.
 * Live status is the hosting node's own report, never a stored row.
 */
export function SwarmyControlPlaneCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const status = useQuery({ ...trpc.mesh.control.status.queryOptions(), refetchInterval: 10_000 });
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  const [moveTo, setMoveTo] = React.useState('');
  const done = (msg: string) => () => {
    toast.success(msg);
    void qc.invalidateQueries();
  };
  const onError = (e: { message: string }) => toast.error(e.message);
  const reconcile = useMutation(trpc.mesh.control.reconcile.mutationOptions({ onSuccess: done('Control plane converged'), onError }));
  const breakGlass = useMutation(trpc.mesh.control.breakGlass.mutationOptions({ onSuccess: done('Break-glass updated'), onError }));
  const move = useMutation(trpc.mesh.control.move.mutationOptions({ onSuccess: done('Control plane moved'), onError }));

  const d = status.data;
  if (!d) return <div className="shimmer-line h-40 rounded-2xl" />;
  const st = d.status;
  const tone = !st ? 'neutral' : st.healthy ? 'online' : st.running ? 'warning' : 'offline';
  const label = !st ? 'no report yet' : st.healthy ? 'healthy' : st.waitingForConfig ? 'waiting for config' : st.running ? 'starting' : 'down';
  const others = (nodes.data ?? []).filter((n: { id: string }) => n.id !== d.node.id);

  return (
    <Card className="calm-card">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Control plane · runs in swarmy</CardTitle>
            <CardDescription>
              NetBird lives on {d.node.hostname ?? 'a node'} as its own container, outside the swarm it serves, so the swarm never
              depends on itself to heal. Tunnels keep working even while it restarts.
            </CardDescription>
          </div>
          <StatusBadge tone={tone} label={label} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        <p className="text-sm">
          Runs in swarmy on <span className="mono-data font-medium">{d.node.hostname ?? '—'}</span> · NetBird v{d.version} ·{' '}
          {d.backup.configured ? (d.backup.running ? 'backed up continuously' : 'backup paused') : 'not backed up'} · {d.peers.total} peer
          {d.peers.total === 1 ? '' : 's'}
          <span className="text-muted-foreground"> · reported {ago(d.statusAt)}</span>
        </p>

        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Address</dt>
            <dd className="mono-data truncate">{d.managementUrl}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Cluster</dt>
            <dd className="mono-data">{d.cluster}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Sign-in</dt>
            <dd>{d.identity.connector ? 'through swarmy only' : 'setting up swarmy sign-in…'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">TLS</dt>
            <dd>{d.tls === 'edge' ? "swarmy's edge" : d.tls === 'letsencrypt' ? "NetBird's own certificate" : 'none (private network)'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Backup</dt>
            <dd className="mono-data">{d.backup.bucket ? `bucket ${d.backup.bucket}` : '—'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Servers on the mesh</dt>
            <dd>{d.peers.servers}</dd>
          </div>
        </dl>

        {d.warnings.length > 0 && (
          <ul className="bg-accent/40 grid gap-1 rounded-xl px-4 py-3 text-sm">
            {d.warnings.map((w: string) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" disabled={reconcile.isPending} onClick={() => reconcile.mutate()}>
            Sync now
          </Button>
          <div className="flex items-center gap-2">
            <Select value={moveTo} onValueChange={setMoveTo}>
              <SelectTrigger className="w-52">
                <SelectValue placeholder="Move to another manager" />
              </SelectTrigger>
              <SelectContent>
                {others.map((n: { id: string; hostname: string }) => (
                  <SelectItem key={n.id} value={n.id}>
                    {n.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" disabled={!moveTo || move.isPending} onClick={() => move.mutate({ nodeId: moveTo })}>
              Move
            </Button>
          </div>
          <label className="ml-auto flex items-center gap-2 text-sm">
            <Switch checked={d.identity.breakGlass} onCheckedChange={(on) => breakGlass.mutate({ on })} />
            Break-glass local login
          </label>
        </div>
      </CardContent>
    </Card>
  );
}
