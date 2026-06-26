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
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/ingress')({
  component: IngressPage,
});

function IngressPage() {
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

  return (
    <div>
      <PageHeader title="Ingress" description="Unopinionated routing — Caddy, Traefik, or bring your own." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Driver</CardTitle>
            <CardDescription>
              With “None”, swarmy tracks domains for display but writes no routing config.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>Ingress driver</Label>
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
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="ingress-on">Enabled</Label>
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

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Rendered config preview</CardTitle>
            <CardDescription>What the agent would apply on ingress nodes.</CardDescription>
          </CardHeader>
          <CardContent>
            {config.data?.driver === 'none' ? (
              <p className="text-muted-foreground text-sm">Nothing is written in “None” mode.</p>
            ) : preview.data ? (
              <pre className="bg-muted max-h-64 overflow-auto rounded-md p-3 font-mono text-xs">
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

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            Domains
            <AddDomainDialog services={services.data ?? []} onDone={invalidate} />
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Host</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Port</TableHead>
                <TableHead>TLS</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(domains.data ?? []).map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.host}</TableCell>
                  <TableCell>{d.serviceName}</TableCell>
                  <TableCell>{d.targetPort}</TableCell>
                  <TableCell>
                    <Badge variant="muted">{d.tls}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => removeDomain.mutate({ id: d.id })}>
                      <Trash2Icon className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {domains.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-8 text-center text-sm">
                    No domains mapped.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
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
            <Label>Host</Label>
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="app.example.com" />
          </div>
          <div className="grid gap-1.5">
            <Label>Service</Label>
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
            <Label>Target port</Label>
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
