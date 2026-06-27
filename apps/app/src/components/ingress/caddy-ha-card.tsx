import * as React from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@swarmy/ui';

interface CaddyHaCardProps {
  haConfigured: boolean;
  onEnable: (host: string) => void;
  onDisable: () => void;
  pending: boolean;
}

/** Caddy shared-cert (Redis-backed) high-availability storage controls. */
export function CaddyHaCard({
  haConfigured,
  onEnable,
  onDisable,
  pending,
}: CaddyHaCardProps): React.JSX.Element {
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
