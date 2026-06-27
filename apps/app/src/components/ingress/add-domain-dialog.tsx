import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import {
  Button,
  type ButtonProps,
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
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ALL_DRIVERS, DRIVER_LABELS, type IngressDriverId } from './driver-config';

interface DomainService {
  id: string;
  name: string;
}

interface AddDomainDialogProps {
  services: DomainService[];
  /** Trigger style — coral default (the page CTA) or outline (empty-state reuse). */
  variant?: ButtonProps['variant'];
}

/** Coral CTA + map-a-domain dialog. Owns the addDomain mutation. */
export function AddDomainDialog({ services, variant = 'default' }: AddDomainDialogProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [host, setHost] = React.useState('');
  const [serviceId, setServiceId] = React.useState('');
  const [port, setPort] = React.useState(80);
  const [driverOverride, setDriverOverride] = React.useState<'inherit' | IngressDriverId>('inherit');

  const add = useMutation(
    trpc.ingress.addDomain.mutationOptions({
      onSuccess: () => {
        toast.success('Domain added');
        setOpen(false);
        setHost('');
        setDriverOverride('inherit');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant}>
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
          <div className="grid gap-1.5">
            <Label className="mono-label">Driver</Label>
            <Select value={driverOverride} onValueChange={(v) => setDriverOverride(v as typeof driverOverride)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">Inherit org default</SelectItem>
                {ALL_DRIVERS.filter((d) => d !== 'none').map((d) => (
                  <SelectItem key={d} value={d}>
                    {DRIVER_LABELS[d]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Override which driver routes this domain, or inherit the org-wide choice.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() =>
              add.mutate({
                host,
                serviceId,
                targetPort: port,
                tls: 'auto',
                ingressDriver: driverOverride === 'inherit' ? null : driverOverride,
              })
            }
            disabled={add.isPending || !host || !serviceId}
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
