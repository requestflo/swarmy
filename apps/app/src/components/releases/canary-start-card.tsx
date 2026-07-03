import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BirdIcon } from 'lucide-react';
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
import { CanaryField, CanaryServicePicker } from './canary-start-fields';

/**
 * Inline expanding start-canary card — never a modal. Pick a service, the
 * candidate image, the traffic share, the watch window and the error ceiling.
 * On submit the controller deploys `<svc>--canary` and shifts that share of
 * ingress traffic to it; the deploy-canary worker promotes or rolls back.
 */
export function CanaryStartCard({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [service, setService] = React.useState('');
  const [image, setImage] = React.useState('');
  const [trafficPct, setTrafficPct] = React.useState(10);
  const [durationMin, setDurationMin] = React.useState(15);
  const [errorPct, setErrorPct] = React.useState(5);

  const services = useQuery({
    ...trpc.services.list.queryOptions({ stackId: stack }),
    enabled: open,
  });
  const candidates = (services.data ?? []).filter((s) => !s.name.endsWith('--canary'));
  const selected = candidates.find((s) => s.name === service);

  const start = useMutation(
    trpc.releases.startCanary.mutationOptions({
      onSuccess: () => {
        toast.success(`Canary started on ${service} — ${trafficPct}% of traffic`);
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const candidate = image.trim();
  const valid =
    service.length > 0 && candidate.length > 0 && candidate !== selected?.image &&
    trafficPct >= 1 && trafficPct <= 99 && durationMin >= 1;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button size="sm" variant={open ? 'outline' : 'default'} className="w-fit">
          <BirdIcon className="size-4" /> Start canary
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="bg-accent/40 mt-3 grid gap-4 rounded-xl border p-4">
          <p className="text-muted-foreground text-xs">
            Run a new image next to the stable one on a slice of real traffic. A clean window
            promotes it automatically; errors roll it back.
          </p>

          <CanaryServicePicker
            candidates={candidates}
            loading={services.isLoading}
            value={service}
            selected={selected}
            onChange={(v) => {
              setService(v);
              const cur = candidates.find((s) => s.name === v);
              if (cur && !image) setImage(cur.image);
            }}
          />

          <div className="grid gap-1.5">
            <Label className="text-sm font-medium">Candidate image</Label>
            <Input
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder="ghcr.io/acme/web:1.4.0-rc.1"
              className="font-mono"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <CanaryField label="Traffic %" min={1} max={99} value={trafficPct} onChange={setTrafficPct} />
            <CanaryField label="Window (min)" min={1} max={1440} value={durationMin} onChange={setDurationMin} />
            <CanaryField label="Error ceiling %" min={0} max={100} value={errorPct} onChange={setErrorPct} />
          </div>
          <p className="text-muted-foreground -mt-2 text-xs">
            Error ceiling 0 disables auto-rollback on error rate (task failures still roll back).
          </p>

          <Button
            className="w-fit"
            disabled={!valid || start.isPending}
            onClick={() =>
              start.mutate({
                stack, service, image: candidate, trafficPct, durationMin,
                rollbackOnErrorRatePct: errorPct > 0 ? errorPct : null,
              })
            }
          >
            {start.isPending ? 'Starting…' : `Start at ${trafficPct}%`}
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
