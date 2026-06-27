import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface CloudflareTunnelCardProps {
  configured: boolean;
  onSave: (v: { tunnelName: string; tunnelId?: string; apiToken?: string }) => void;
  onClear: () => void;
  pending: boolean;
}

/** Cloudflare Tunnel connector — create via API or wire up a manual tunnel. */
export function CloudflareTunnelCard({
  configured,
  onSave,
  onClear,
  pending,
}: CloudflareTunnelCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const tunnel = useQuery(trpc.ingress.tunnels.get.queryOptions());
  const [tunnelName, setTunnelName] = React.useState('swarmy');
  const [tunnelId, setTunnelId] = React.useState('');
  const [accountId, setAccountId] = React.useState('');
  const [apiToken, setApiToken] = React.useState('');

  const createTunnel = useMutation(
    trpc.ingress.tunnels.create.mutationOptions({
      onSuccess: () => {
        toast.success('Tunnel created via Cloudflare API + connector deployed');
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const syncTunnel = useMutation(
    trpc.ingress.tunnels.sync.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Pushed ${r.rules} ingress rule(s) to Cloudflare`);
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const deleteTunnel = useMutation(
    trpc.ingress.tunnels.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Tunnel deleted');
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const connected = configured || !!tunnel.data?.connected;

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Cloudflare Tunnel</CardTitle>
        <CardDescription>
          Expose services with no public IP and no open ports. Paste a scoped Cloudflare API token —
          it is encrypted at rest and never returned. With an account id we create the tunnel for
          you and deploy the connector as a swarm service.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {connected ? (
          <div className="grid gap-3">
            <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
              <div>
                <Label className="font-medium">{tunnel.data?.tunnelName ?? 'Tunnel'} configured</Label>
                <p className="text-muted-foreground text-xs">
                  {tunnel.data?.tunnelId
                    ? `id ${tunnel.data.tunnelId.slice(0, 12)}… · connector runs as a swarm service`
                    : 'Connector runs as a swarm service.'}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => syncTunnel.mutate({})}
                  disabled={syncTunnel.isPending || !tunnel.data?.tunnelId}
                >
                  Sync routes
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => (tunnel.data?.tunnelId ? deleteTunnel.mutate() : onClear())}
                  disabled={pending || deleteTunnel.isPending}
                >
                  Disconnect
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-1.5">
              <Label className="mono-label">Tunnel name</Label>
              <Input value={tunnelName} onChange={(e) => setTunnelName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Cloudflare account id (creates the tunnel via API)</Label>
              <Input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="account id" />
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Tunnel ID (optional — manual mode)</Label>
              <Input value={tunnelId} onChange={(e) => setTunnelId(e.target.value)} placeholder="uuid" />
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Cloudflare API token</Label>
              <Input
                type="password"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder="Account: Tunnel Edit · Zone: DNS Edit"
              />
            </div>
            {accountId ? (
              <Button
                onClick={() => createTunnel.mutate({ name: tunnelName, accountId, apiToken })}
                disabled={createTunnel.isPending || !apiToken || !accountId}
              >
                Create tunnel via API
              </Button>
            ) : (
              <Button
                onClick={() => onSave({ tunnelName, tunnelId: tunnelId || undefined, apiToken: apiToken || undefined })}
                disabled={pending || !apiToken}
              >
                Save tunnel (manual)
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
