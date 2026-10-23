import * as React from 'react';
import { Button, Input, Label } from '@swarmy/ui';
import { Section } from '@/components/calm';

interface CloudflareTunnelCardProps {
  configured: boolean;
  onSave: (v: { runToken: string; tunnelName?: string }) => void;
  onClear: () => void;
  pending: boolean;
}

/**
 * Cloudflare Tunnel: paste the tunnel's token. swarmy runs the connector as a
 * swarm service; public hostnames are added on the Cloudflare side (the preview
 * above lists the hostname → service rules to add).
 */
export function CloudflareTunnelCard({
  configured,
  onSave,
  onClear,
  pending,
}: CloudflareTunnelCardProps): React.JSX.Element {
  const [token, setToken] = React.useState('');
  const [tunnelName, setTunnelName] = React.useState('swarmy');

  return (
    <Section title="Cloudflare Tunnel">
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          Expose services with no public IP and no open ports. In Cloudflare Zero Trust → Networks →
          Tunnels, create a tunnel and copy its token; swarmy runs the connector for you. Add each
          public hostname to the tunnel in Cloudflare, pointing at the service shown in the preview.
        </p>
      <div className="grid gap-3">
        {configured ? (
          <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
            <div>
              <Label className="font-medium">Tunnel connected</Label>
              <p className="text-muted-foreground text-xs">The connector runs as a swarm service.</p>
            </div>
            <Button variant="outline" size="sm" onClick={onClear} disabled={pending}>
              Disconnect
            </Button>
          </div>
        ) : (
          <>
            <div className="grid gap-1.5">
              <Label className="mono-label">Tunnel token</Label>
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="eyJhIjoi…"
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Name (for your reference)</Label>
              <Input value={tunnelName} onChange={(e) => setTunnelName(e.target.value)} />
            </div>
            <Button variant="outline"
              onClick={() => onSave({ runToken: token.trim(), tunnelName: tunnelName.trim() || undefined })}
              disabled={pending || token.trim().length < 20}
            >
              Connect tunnel
            </Button>
          </>
        )}
      </div>
    </Section>
  );
}
