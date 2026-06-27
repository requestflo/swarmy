import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { INGRESS_DRIVER_LABELS } from '@swarmy/core';

type IngressDriverId = 'none' | 'caddy' | 'traefik' | 'cloudflared';

/**
 * Local label map so the UI compiles before the integrator widens
 * `INGRESS_DRIVER_LABELS` in @swarmy/core (see INTEGRATION). Falls back to the
 * shared map for the existing three drivers.
 */
const DRIVER_LABELS: Record<IngressDriverId, string> = {
  none: INGRESS_DRIVER_LABELS.none,
  caddy: INGRESS_DRIVER_LABELS.caddy,
  traefik: INGRESS_DRIVER_LABELS.traefik,
  cloudflared: 'Cloudflare Tunnel',
};

const DRIVER_BLURB: Record<IngressDriverId, string> = {
  none: 'Unopinionated by default. Bring your own proxy — swarmy stays out of the way.',
  caddy: 'Automatic HTTPS. Recommended. Needs a public IP and a domain.',
  traefik: 'Advanced / bring-your-own. Label-based routing for existing Traefik users.',
  cloudflared: 'No public IP needed — connect via Cloudflare. Needs a Cloudflare account.',
};
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
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

export const Route = createFileRoute('/_authed/ingress')({
  component: IngressPage,
});

function IngressPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const config = useQuery(trpc.ingress.getConfig.queryOptions());
  const domains = useQuery(trpc.ingress.listDomains.queryOptions());
  const services = useQuery(trpc.services.list.queryOptions({}));
  const preview = useQuery({
    ...trpc.ingress.previewConfig.queryOptions({}),
    enabled: (config.data?.driver ?? 'none') !== 'none',
  });

  const invalidate = () => qc.invalidateQueries();
  const setDriver = useMutation(
    trpc.ingress.setDriver.mutationOptions({ onSuccess: invalidate, onError: (e) => toast.error(e.message) }),
  );
  const setEnabled = useMutation(
    trpc.ingress.setEnabled.mutationOptions({ onSuccess: invalidate, onError: (e) => toast.error(e.message) }),
  );
  const removeDomain = useMutation(
    trpc.ingress.removeDomain.mutationOptions({ onSuccess: invalidate, onError: (e) => toast.error(e.message) }),
  );
  const setHaStorage = useMutation(
    trpc.ingress.setHaStorage.mutationOptions({
      onSuccess: () => {
        toast.success('Shared-cert storage updated');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setTunnel = useMutation(
    trpc.ingress.setTunnel.mutationOptions({
      onSuccess: () => {
        toast.success('Cloudflare tunnel updated');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const driver = config.data?.driver ?? 'none';
  const isNone = driver === 'none';
  const enabled = !!config.data?.enabled;
  const domainCount = domains.data?.length ?? 0;
  const live = enabled && !isNone;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Ingress"
        title={
          domainCount > 0 ? (
            <>
              <CountUp value={domainCount} /> domain{domainCount === 1 ? '' : 's'} <em>routed</em>.
            </>
          ) : (
            <>
              Routing, <em>your</em> way.
            </>
          )
        }
        description="Pick a driver — or none at all. swarmy stays unopinionated about how traffic reaches your services."
        actions={
          <StatusBadge
            tone={live ? 'online' : 'neutral'}
            label={live ? `${DRIVER_LABELS[driver as IngressDriverId]} · live` : isNone ? 'Tracking only' : 'Paused'}
          />
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="card-pop border-0">
          <CardHeader>
            <CardTitle className="text-base">Driver</CardTitle>
            <CardDescription>
              Choose <strong className="text-foreground">None</strong> to stay fully unopinionated — swarmy tracks
              domains for display but writes no routing config to your nodes.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="grid gap-1.5">
              <Label className="mono-label">Ingress driver</Label>
              <Select
                value={config.data?.driver ?? 'none'}
                onValueChange={(v) => setDriver.mutate({ driver: v as IngressDriverId })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['none', 'caddy', 'traefik', 'cloudflared'] as const).map((d) => (
                    <SelectItem key={d} value={d}>
                      {DRIVER_LABELS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground mt-1 text-xs">{DRIVER_BLURB[driver as IngressDriverId]}</p>
            </div>
            <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
              <div>
                <Label htmlFor="ingress-on" className="font-medium">
                  Enabled
                </Label>
                <p className="text-muted-foreground text-xs">Master switch — off writes nothing to nodes.</p>
              </div>
              <Switch
                id="ingress-on"
                checked={!!config.data?.enabled}
                onCheckedChange={(v) => setEnabled.mutate({ enabled: v })}
              />
            </div>
          </CardContent>
        </Card>

        <Card className="card-pop border-0">
          <CardHeader>
            <CardTitle className="text-base">Rendered config preview</CardTitle>
            <CardDescription>What the agent would apply on ingress nodes.</CardDescription>
          </CardHeader>
          <CardContent>
            {config.data?.driver === 'none' ? (
              <div className="text-muted-foreground flex h-40 flex-col items-center justify-center gap-2 text-center text-sm">
                <span className="mono-label">None mode</span>
                <p>Nothing written. You're in charge of routing.</p>
              </div>
            ) : preview.data ? (
              <pre className="bg-muted mono-data max-h-64 overflow-auto rounded-xl p-4 text-xs">
                {preview.data.summary}
                {'\n\n'}
                {preview.data.files.map((f) => `# ${f.path}\n${f.contents}`).join('\n')}
              </pre>
            ) : (
              <p className="text-muted-foreground text-sm">No preview.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {driver === 'caddy' ? (
        <CaddyHaCard
          haConfigured={!!config.data?.haConfigured}
          onEnable={(host) => setHaStorage.mutate({ host })}
          onDisable={() => setHaStorage.mutate(null)}
          pending={setHaStorage.isPending}
        />
      ) : null}

      {driver === 'cloudflared' ? (
        <CloudflareTunnelCard
          configured={!!config.data?.tunnelConfigured}
          onSave={(v) => setTunnel.mutate(v)}
          onClear={() => setTunnel.mutate(null)}
          pending={setTunnel.isPending}
        />
      ) : null}

      <Card className="card-pop mt-6 border-0">
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            Domains
            <AddDomainDialog services={services.data ?? []} onDone={invalidate} />
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="grid grid-cols-[1fr_auto] gap-x-4 px-6 pb-2 sm:grid-cols-[2fr_1.5fr_auto_auto_auto]">
            <span className="mono-label">Host</span>
            <span className="mono-label hidden sm:block">Service</span>
            <span className="mono-label hidden sm:block">Port</span>
            <span className="mono-label hidden sm:block">TLS</span>
            <span className="mono-label text-right">{domainCount > 0 ? domainCount : ''}</span>
          </div>
          <div className="border-t">
            {(domains.data ?? []).map((d) => (
              <div
                key={d.id}
                className="hover:bg-accent/60 grid grid-cols-[1fr_auto] items-center gap-x-4 border-b px-6 py-3 transition-colors last:border-b-0 sm:grid-cols-[2fr_1.5fr_auto_auto_auto]"
              >
                <div className="min-w-0">
                  <p className="mono-data truncate font-medium">{d.host}</p>
                  <p className="text-muted-foreground mono-label sm:hidden">
                    {d.serviceName} · :{d.targetPort} · {d.tls}
                  </p>
                </div>
                <span className="hidden truncate sm:block">{d.serviceName}</span>
                <span className="mono-data hidden sm:block">:{d.targetPort}</span>
                <span className="hidden sm:block">
                  <Badge variant="muted">{d.tls}</Badge>
                </span>
                <div className="text-right">
                  <Button variant="ghost" size="icon" onClick={() => removeDomain.mutate({ id: d.id })}>
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
            {domains.data?.length === 0 && (
              <div className="text-muted-foreground px-6 py-12 text-center text-sm">
                No domains mapped yet. Point one at a service to send it traffic.
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CaddyHaCard({
  haConfigured,
  onEnable,
  onDisable,
  pending,
}: {
  haConfigured: boolean;
  onEnable: (host: string) => void;
  onDisable: () => void;
  pending: boolean;
}) {
  const [host, setHost] = React.useState('');
  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">High availability — shared certificates</CardTitle>
        <CardDescription>
          Run Caddy on multiple nodes with one shared certificate pool (Redis-backed). One ACME
          account, issued once, read by every instance — no re-issuance, no rate-limit hits.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {haConfigured ? (
          <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
            <div>
              <Label className="font-medium">Shared storage active</Label>
              <p className="text-muted-foreground text-xs">All Caddy instances share one cert pool.</p>
            </div>
            <Button variant="outline" size="sm" onClick={onDisable} disabled={pending}>
              Disable
            </Button>
          </div>
        ) : (
          <div className="grid gap-1.5">
            <Label className="mono-label">Redis host</Label>
            <div className="flex gap-2">
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="redis-ingress:6379 host (e.g. redis)"
              />
              <Button onClick={() => onEnable(host)} disabled={pending || !host}>
                Enable HA
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Point every Caddy node at one Redis. Credentials are encrypted at rest.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CloudflareTunnelCard({
  configured,
  onSave,
  onClear,
  pending,
}: {
  configured: boolean;
  onSave: (v: { tunnelName: string; tunnelId?: string; apiToken?: string }) => void;
  onClear: () => void;
  pending: boolean;
}) {
  const [tunnelName, setTunnelName] = React.useState('swarmy');
  const [tunnelId, setTunnelId] = React.useState('');
  const [apiToken, setApiToken] = React.useState('');
  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Cloudflare Tunnel</CardTitle>
        <CardDescription>
          Expose services with no public IP and no open ports. Paste a scoped Cloudflare API token —
          it is encrypted at rest and never returned.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {configured ? (
          <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
            <div>
              <Label className="font-medium">Tunnel configured</Label>
              <p className="text-muted-foreground text-xs">Connector runs as a swarm service.</p>
            </div>
            <Button variant="outline" size="sm" onClick={onClear} disabled={pending}>
              Disconnect
            </Button>
          </div>
        ) : (
          <>
            <div className="grid gap-1.5">
              <Label className="mono-label">Tunnel name</Label>
              <Input value={tunnelName} onChange={(e) => setTunnelName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Tunnel ID (optional — created via API if blank)</Label>
              <Input value={tunnelId} onChange={(e) => setTunnelId(e.target.value)} placeholder="uuid" />
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Cloudflare API token</Label>
              <Input
                type="password"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder="Account: Tunnel Edit · Zone: DNS Edit"
              />
            </div>
            <Button
              onClick={() => onSave({ tunnelName, tunnelId: tunnelId || undefined, apiToken: apiToken || undefined })}
              disabled={pending || !apiToken}
            >
              Save tunnel
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AddDomainDialog({
  services,
  onDone,
}: {
  services: { id: string; name: string }[];
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const [open, setOpen] = React.useState(false);
  const [host, setHost] = React.useState('');
  const [serviceId, setServiceId] = React.useState('');
  const [port, setPort] = React.useState(80);

  const add = useMutation(
    trpc.ingress.addDomain.mutationOptions({
      onSuccess: () => {
        toast.success('Domain added');
        setOpen(false);
        setHost('');
        onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon className="size-4" /> Add domain
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Map a domain</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="mono-label">Host</Label>
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="app.example.com" />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Service</Label>
            <Select value={serviceId} onValueChange={setServiceId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a service" />
              </SelectTrigger>
              <SelectContent>
                {services.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Target port</Label>
            <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => add.mutate({ host, serviceId, targetPort: port, tls: 'auto' })}
            disabled={add.isPending || !host || !serviceId}
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
