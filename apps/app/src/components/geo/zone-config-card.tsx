import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface ZoneConfigCardProps {
  enabled: boolean;
  /** Seed values from the persisted config (sync via key remount or effect upstream). */
  initialZone: string;
  initialTtl: number;
  /** Invalidate queries after a mutation (mirrors the page invalidate). */
  onChange: () => void;
}

/** Zone identity + TTL + the deploy/apply/enable controls. Owns its mutations. */
export function ZoneConfigCard({
  enabled,
  initialZone,
  initialTtl,
  onChange,
}: ZoneConfigCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const [zone, setZone] = React.useState(initialZone);
  const [ttl, setTtl] = React.useState(initialTtl);

  React.useEffect(() => {
    setZone(initialZone);
    setTtl(initialTtl);
  }, [initialZone, initialTtl]);

  const onErr = (e: { message: string }): void => {
    toast.error(e.message);
  };

  const setEnabled = useMutation(
    trpc.geodns.setEnabled.mutationOptions({ onSuccess: onChange, onError: onErr }),
  );
  const setConfig = useMutation(
    trpc.geodns.setConfig.mutationOptions({
      onSuccess: () => {
        toast.success('Zone config saved');
        onChange();
      },
      onError: onErr,
    }),
  );
  const applyNow = useMutation(
    trpc.geodns.applyNow.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.summary);
        onChange();
      },
      onError: onErr,
    }),
  );

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Zone</CardTitle>
        <CardDescription>
          Enabling deploys CoreDNS as a managed swarm service and starts answering for this zone. DNS
          failover is soft (resolver caching) — low TTL biases new clients toward healthy regions.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-1.5">
          <Label className="mono-label">Zone</Label>
          <Input
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            placeholder="geo.example.com"
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">TTL (seconds)</Label>
          <Input
            type="number"
            min={10}
            max={120}
            value={ttl}
            onChange={(e) => setTtl(Number(e.target.value))}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            className="flex-1"
            onClick={() => setConfig.mutate({ zone, ttl })}
            disabled={setConfig.isPending || !zone}
          >
            Save zone
          </Button>
          <Button
            variant="outline"
            onClick={() => applyNow.mutate()}
            disabled={applyNow.isPending || !enabled}
            title="Re-render the health-filtered zone and redeploy CoreDNS now"
          >
            Apply now
          </Button>
        </div>
        <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
          <div>
            <Label htmlFor="geo-on" className="font-medium">
              Enabled
            </Label>
            <p className="text-muted-foreground text-xs">Deploys / removes the CoreDNS service.</p>
          </div>
          <Switch
            id="geo-on"
            checked={enabled}
            onCheckedChange={(v) => setEnabled.mutate({ enabled: v })}
          />
        </div>
      </CardContent>
    </Card>
  );
}
