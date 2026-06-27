import * as React from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@swarmy/ui';

export type MeshDriverId = 'none' | 'netbird' | 'headscale' | 'tailscale' | 'wireguard';

export const DRIVER_ORDER: MeshDriverId[] = ['none', 'netbird', 'headscale', 'tailscale', 'wireguard'];

export const DRIVER_LABELS: Record<MeshDriverId, string> = {
  none: 'None',
  netbird: 'NetBird',
  headscale: 'Headscale',
  tailscale: 'Tailscale',
  wireguard: 'WireGuard',
};

const DRIVER_BLURB: Record<MeshDriverId, string> = {
  none: 'Unopinionated by default. Nodes use their own network — swarmy stays out of the way.',
  netbird: 'Zero-trust WireGuard mesh. Any node, any cloud, behind NAT — no inbound ports.',
  headscale: 'Self-hosted Tailscale control plane. Official clients, config-as-code ACLs.',
  tailscale: 'Bring your own Tailscale tailnet — SaaS control plane, best NAT traversal.',
  wireguard: 'Raw WireGuard. swarmy templates wg0.conf; you own routing & NAT.',
};

interface MeshDriverCardProps {
  driver: MeshDriverId;
  enabled: boolean;
  isNone: boolean;
  onDriverChange: (driver: MeshDriverId) => void;
  onEnabledChange: (enabled: boolean) => void;
}

/** Networking → pick the mesh driver + the master on/off switch. */
export function MeshDriverCard({
  driver,
  enabled,
  isNone,
  onDriverChange,
  onEnabledChange,
}: MeshDriverCardProps): React.JSX.Element {
  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Driver</CardTitle>
        <CardDescription>
          <strong className="text-foreground">None</strong> stays the default — swarmy provisions no
          mesh and your nodes keep their own networking. Pick{' '}
          <strong className="text-foreground">NetBird</strong> to mesh them over WireGuard.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-1.5">
          <Label className="mono-label">Mesh driver</Label>
          <Select value={driver} onValueChange={(v) => onDriverChange(v as MeshDriverId)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DRIVER_ORDER.map((d) => (
                <SelectItem key={d} value={d}>
                  {DRIVER_LABELS[d]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground mt-1 text-xs">{DRIVER_BLURB[driver]}</p>
        </div>
        <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
          <div>
            <Label htmlFor="mesh-on" className="font-medium">
              Enabled
            </Label>
            <p className="text-muted-foreground text-xs">
              Master switch — off provisions nothing. None stays the default.
            </p>
          </div>
          <Switch
            id="mesh-on"
            checked={enabled}
            disabled={isNone}
            onCheckedChange={onEnabledChange}
          />
        </div>
      </CardContent>
    </Card>
  );
}
