import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { INGRESS_DRIVER_LABELS } from '@swarmy/core';
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
            label={live ? `${INGRESS_DRIVER_LABELS[driver]} · live` : isNone ? 'Tracking only' : 'Paused'}
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
                onValueChange={(v) => setDriver.mutate({ driver: v as 'caddy' | 'traefik' | 'none' })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['caddy', 'traefik', 'none'] as const).map((d) => (
                    <SelectItem key={d} value={d}>
                      {INGRESS_DRIVER_LABELS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isNone ? (
                <p className="text-muted-foreground mt-1 text-xs">
                  Unopinionated by default. Bring your own proxy — swarmy stays out of the way.
                </p>
              ) : null}
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
