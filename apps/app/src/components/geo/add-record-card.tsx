import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Collapsible, CollapsibleContent, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface AddRecordCardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Inline expanding "map a host to a region" card — replaces the old dialog. */
export function AddRecordCard({ open, onOpenChange }: AddRecordCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [host, setHost] = React.useState('');
  const [region, setRegion] = React.useState('');
  const [target, setTarget] = React.useState('');

  const add = useMutation(
    trpc.geodns.upsertRecord.mutationOptions({
      onSuccess: () => {
        toast.success(`${host} steered to ${region}`);
        setHost('');
        setRegion('');
        setTarget('');
        onOpenChange(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const ready = !!host && !!region && !!target;

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleContent>
        <div className="card-pop space-y-4 p-5">
          <div>
            <p className="text-sm font-bold">Map a host to a regional ingress</p>
            <p className="text-muted-foreground text-xs">
              Geo-DNS steers visitors to the nearest healthy region for this host.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label className="mono-label">Host</Label>
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="app.geo.example.com" />
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Region</Label>
              <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east" />
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Target ingress</Label>
              <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="203.0.113.10" />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => add.mutate({ host, region, targetIngress: target })}
              disabled={!ready || add.isPending}
            >
              {add.isPending ? 'Saving…' : 'Save record'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
