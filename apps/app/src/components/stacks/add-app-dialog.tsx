import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, XIcon } from 'lucide-react';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Label,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * `"8080:80, 53:53/udp"` → spec ports. Last colon-part is the container target,
 * the one before it (if any) is the published host port. A trailing `/udp`
 * flips the protocol. Mirrors the compose-port parsing in stack.service.
 */
function parsePorts(raw: string): { target: number; published?: number; protocol: 'tcp' | 'udp' }[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hostPort = '', proto] = entry.split('/');
      const parts = hostPort.split(':');
      const target = Number(parts[parts.length - 1]);
      const published = parts.length > 1 ? Number(parts[parts.length - 2]) : undefined;
      return {
        target,
        published: Number.isFinite(published) ? published : undefined,
        protocol: proto?.toLowerCase() === 'udp' ? ('udp' as const) : ('tcp' as const),
      };
    })
    .filter((p) => Number.isFinite(p.target) && p.target > 0);
}

interface AddAppDialogProps {
  stack: string;
  /** Trigger label — the settings tab says "Add a service". */
  label?: string;
}

/**
 * Contextual deploy as an INLINE expanding card (no modal): drop a single app
 * straight into an existing stack. Owns the `stacks.addServiceToStack`
 * mutation; the new service is stamped into the `<stack>` namespace.
 */
export function AddAppDialog({ stack, label = 'Add app' }: AddAppDialogProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [image, setImage] = React.useState('');
  const [ports, setPorts] = React.useState('');
  const [replicas, setReplicas] = React.useState('1');

  const add = useMutation(
    trpc.stacks.addServiceToStack.mutationOptions({
      onSuccess: () => {
        toast.success(`Adding ${name} to ${stack}`);
        setOpen(false);
        setName('');
        setImage('');
        setPorts('');
        setReplicas('1');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const submit = (): void =>
    add.mutate({
      stack,
      name,
      image,
      ports: parsePorts(ports),
      replicas: Math.max(1, Math.trunc(Number(replicas)) || 1),
    });

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="outline" className="gap-2">
          {open ? <XIcon className="size-4" /> : <PlusIcon className="size-4" />}
          {open ? 'Close' : label}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="card-pop mt-2 w-full max-w-md space-y-3 p-4 text-left">
          <div>
            <p className="text-sm font-semibold">Add a service to {stack}</p>
            <p className="text-muted-foreground text-xs">
              Deploys one service stamped into the <span className="mono-data">{stack}</span>{' '}
              namespace.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="add-app-name" className="mono-label">Name</Label>
              <Input id="add-app-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="cache" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="add-app-image" className="mono-label">Image</Label>
              <Input id="add-app-image" value={image} onChange={(e) => setImage(e.target.value)} placeholder="redis:7" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="add-app-ports" className="mono-label">Ports</Label>
              <Input id="add-app-ports" value={ports} onChange={(e) => setPorts(e.target.value)} placeholder="8080:80" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="add-app-replicas" className="mono-label">Replicas</Label>
              <Input id="add-app-replicas" type="number" min={1} value={replicas} onChange={(e) => setReplicas(e.target.value)} />
            </div>
          </div>
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={submit} disabled={add.isPending || !name || !image}>
              {add.isPending ? 'Adding…' : 'Add service'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
