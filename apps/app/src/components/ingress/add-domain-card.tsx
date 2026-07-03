import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Collapsible,
  CollapsibleContent,
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

interface AddDomainCardProps {
  stack: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Inline expanding "map a domain" card — this stack's services only. */
export function AddDomainCard({ stack, open, onOpenChange }: AddDomainCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const services = useQuery({ ...trpc.services.list.queryOptions({ stackId: stack }), enabled: open });
  const [host, setHost] = React.useState('');
  const [pathPrefix, setPathPrefix] = React.useState('');
  const [serviceId, setServiceId] = React.useState('');
  const [port, setPort] = React.useState(80);
  const [tls, setTls] = React.useState<'auto' | 'off' | 'custom'>('auto');

  const add = useMutation(
    trpc.ingress.addDomain.mutationOptions({
      onSuccess: () => {
        toast.success(`${host} added`);
        setHost('');
        setPathPrefix('');
        setServiceId('');
        onOpenChange(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const options = services.data ?? [];
  const ready = host.trim().length > 0 && serviceId.length > 0;

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleContent>
        <div className="card-pop space-y-4 p-5">
          <div>
            <p className="text-sm font-bold">Map a domain</p>
            <p className="text-muted-foreground text-xs">
              Writes onto the target service's <code className="mono-data">swarmy.ingress.routes</code>{' '}
              label — no controller redeploy needed to take effect.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label className="mono-label">Host</Label>
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="app.example.com" />
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Path prefix (optional)</Label>
              <Input value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} placeholder="/api" />
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Service</Label>
              <Select value={serviceId} onValueChange={setServiceId}>
                <SelectTrigger>
                  <SelectValue placeholder={options.length ? 'Select a service' : 'No services in this stack'} />
                </SelectTrigger>
                <SelectContent>
                  {options.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Target port</Label>
              <Input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label className="mono-label">TLS</Label>
              <Select value={tls} onValueChange={(v) => setTls(v as typeof tls)}>
                <SelectTrigger className="sm:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Automatic HTTPS</SelectItem>
                  <SelectItem value="custom">Custom certificate</SelectItem>
                  <SelectItem value="off">Off (plain HTTP)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                add.mutate({
                  host: host.trim(),
                  serviceId,
                  targetPort: port,
                  tls,
                  pathPrefix: pathPrefix.trim() || undefined,
                })
              }
              disabled={!ready || add.isPending}
            >
              {add.isPending ? 'Adding…' : 'Add domain'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
