import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
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
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface AddRecordDialogProps {
  /** Invalidate queries after a successful upsert (mirrors the page invalidate). */
  onDone: () => void;
  /** Trigger style — coral default (the page CTA) or outline (empty-state reuse). */
  variant?: ButtonProps['variant'];
}

/** Coral CTA + map-a-host-to-region dialog. Owns the upsertRecord mutation. */
export function AddRecordDialog({ onDone, variant = 'default' }: AddRecordDialogProps): React.JSX.Element {
  const trpc = useTRPC();
  const [open, setOpen] = React.useState(false);
  const [host, setHost] = React.useState('');
  const [region, setRegion] = React.useState('');
  const [target, setTarget] = React.useState('');

  const add = useMutation(
    trpc.geodns.upsertRecord.mutationOptions({
      onSuccess: () => {
        toast.success('Record saved');
        setOpen(false);
        setHost('');
        setRegion('');
        setTarget('');
        onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <PlusIcon className="size-4" /> Add record
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Map a host to a regional ingress</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="mono-label">Host</Label>
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="app.geo.example.com"
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Region</Label>
            <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east" />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Target ingress (IP or hostname)</Label>
            <Input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="203.0.113.10"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => add.mutate({ host, region, targetIngress: target })}
            disabled={add.isPending || !host || !region || !target}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
