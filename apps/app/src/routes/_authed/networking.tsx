import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
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
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';
import { ControlPlaneCard } from '@/components/networking/control-plane-card';
import { DirectConnectCard } from '@/components/networking/direct-connect-card';

type MeshDriverId = 'none' | 'netbird' | 'headscale' | 'tailscale' | 'wireguard';

const DRIVER_ORDER: MeshDriverId[] = ['none', 'netbird', 'headscale', 'tailscale', 'wireguard'];

const DRIVER_LABELS: Record<MeshDriverId, string> = {
  none: 'None',
  netbird: 'NetBird',
  headscale: 'Headscale',
  tailscale: 'Tailscale',
  wireguard: 'WireGuard',
};

const DRIVER_BLURB: Record<MeshDriverId, string> = {
  none: 'Unopinionated by default. Nodes use their own network — swarmy stays out of the way.',
  netbird: 'Zero-trust WireGuard mesh. Any node, any cloud, behind NAT — no inbound ports.',
  headscale: 'Self-hosted Tailscale control plane. Official clients, config-as-code ACLs.',
  tailscale: 'Bring your own Tailscale tailnet — SaaS control plane, best NAT traversal.',
  wireguard: 'Raw WireGuard. swarmy templates wg0.conf; you own routing & NAT.',
};

export const Route = createFileRoute('/_authed/networking')({
  component: NetworkingPage,
});

function NetworkingPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const config = useQuery(trpc.mesh.getConfig.queryOptions());
  const peers = useQuery({
    ...trpc.mesh.listPeers.queryOptions(),
    refetchInterval: 10_000,
  });
  const nodes = useQuery(trpc.nodes.list.queryOptions());

  const invalidate = () => qc.invalidateQueries();
  const setDriver = useMutation(
    trpc.mesh.setDriver.mutationOptions({ onSuccess: invalidate, onError: (e) => toast.error(e.message) }),
  );
  const setEnabled = useMutation(
    trpc.mesh.setEnabled.mutationOptions({ onSuccess: invalidate, onError: (e) => toast.error(e.message) }),
  );
  const enrollNode = useMutation(
    trpc.mesh.enrollNode.mutationOptions({
      onSuccess: () => {
        toast.success('Node enrolling in the mesh');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const driver = (config.data?.driver ?? 'none') as MeshDriverId;
  const isNone = driver === 'none';
  const enabled = !!config.data?.enabled;
  const live = enabled && !isNone;
  const peerCount = peers.data?.length ?? 0;
  const [enrollNodeId, setEnrollNodeId] = React.useState('');

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Networking"
        title={
          peerCount > 0 ? (
            <>
              <CountUp value={peerCount} /> peer{peerCount === 1 ? '' : 's'} <em>meshed</em>.
            </>
          ) : (
            <>
              One mesh, <em>anywhere</em>.
            </>
          )
        }
        description="Join every node to one encrypted WireGuard mesh — any cloud, any NAT, no open ports. Or leave it off and keep your own network."
        actions={
          <StatusBadge
            tone={live ? 'online' : 'neutral'}
            label={live ? `${DRIVER_LABELS[driver]} · live` : isNone ? 'None · default' : 'Paused'}
          />
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="card-pop border-0">
          <CardHeader>
            <CardTitle className="text-base">Driver</CardTitle>
            <CardDescription>
              <strong className="text-foreground">None</strong> stays the default — swarmy provisions no
              mesh and your nodes keep their own networking. Pick <strong className="text-foreground">NetBird</strong>{' '}
              to mesh them over WireGuard.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="grid gap-1.5">
              <Label className="mono-label">Mesh driver</Label>
              <Select value={driver} onValueChange={(v) => setDriver.mutate({ driver: v as MeshDriverId })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DRIVER_ORDER.map((d) => (
                    <SelectItem key={d} value={d}>
                      {DRIVER_LABELS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground mt-1 text-xs">{DRIVER_BLURB[driver]}</p>
            </div>
            <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
              <div>
                <Label htmlFor="mesh-on" className="font-medium">
                  Enabled
                </Label>
                <p className="text-muted-foreground text-xs">
                  Master switch — off provisions nothing. None stays the default.
                </p>
              </div>
              <Switch
                id="mesh-on"
                checked={enabled}
                disabled={isNone}
                onCheckedChange={(v) => setEnabled.mutate({ enabled: v })}
              />
            </div>
          </CardContent>
        </Card>

        <Card className="card-pop border-0">
          <CardHeader>
            <CardTitle className="text-base">Enroll a node</CardTitle>
            <CardDescription>
              Provision a single-use setup key and join a node to the mesh. The agent installs the
              NetBird client — no inbound ports, no firewall edits.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {isNone || !enabled ? (
              <div className="text-muted-foreground flex h-32 flex-col items-center justify-center gap-2 text-center text-sm">
                <span className="mono-label">Mesh off</span>
                <p>Pick NetBird and enable the mesh to enroll nodes.</p>
              </div>
            ) : (
              <>
                <Label className="mono-label">Node</Label>
                <div className="flex gap-2">
                  <Select value={enrollNodeId} onValueChange={setEnrollNodeId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a node" />
                    </SelectTrigger>
                    <SelectContent>
                      {(nodes.data ?? []).map((n) => (
                        <SelectItem key={n.id} value={n.id}>
                          {n.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={() => enrollNode.mutate({ nodeId: enrollNodeId })}
                    disabled={enrollNode.isPending || !enrollNodeId}
                  >
                    Enroll
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  The setup key is single-use and short-lived; it never touches disk on the node.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {!isNone && (
        <div className="mt-4">
          <ControlPlaneCard driver={driver} />
        </div>
      )}

      <Card className="card-pop mt-6 border-0">
        <CardHeader>
          <CardTitle className="text-base">Peers</CardTitle>
          <CardDescription>Nodes joined to the mesh and their live status.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="grid grid-cols-[1fr_auto] gap-x-4 px-6 pb-2 sm:grid-cols-[2fr_1.5fr_1fr_auto]">
            <span className="mono-label">Node</span>
            <span className="mono-label hidden sm:block">Mesh IP</span>
            <span className="mono-label hidden sm:block">Last seen</span>
            <span className="mono-label text-right">{peerCount > 0 ? peerCount : ''}</span>
          </div>
          <div className="border-t">
            {(peers.data ?? []).map((p) => (
              <div
                key={p.id}
                className="hover:bg-accent/60 grid grid-cols-[1fr_auto] items-center gap-x-4 border-b px-6 py-3 transition-colors last:border-b-0 sm:grid-cols-[2fr_1.5fr_1fr_auto]"
              >
                <div className="min-w-0">
                  <p className="mono-data truncate font-medium">{p.nodeId}</p>
                  <p className="text-muted-foreground mono-label sm:hidden">
                    {p.meshIp ?? '—'} · {p.status}
                  </p>
                </div>
                <span className="mono-data hidden sm:block">{p.meshIp ?? '—'}</span>
                <span className="mono-data text-muted-foreground hidden sm:block">
                  {p.lastSeen ? new Date(p.lastSeen).toLocaleTimeString() : '—'}
                </span>
                <div className="text-right">
                  <Badge variant="muted">{p.status.toLowerCase()}</Badge>
                </div>
              </div>
            ))}
            {peerCount === 0 && (
              <div className="text-muted-foreground px-6 py-12 text-center text-sm">
                No peers yet. Enable NetBird and enroll a node to mesh your fleet.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {live && <DirectConnectCard />}
    </div>
  );
}
