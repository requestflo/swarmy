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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SwarmyControlPlaneCard } from './swarmy-control-plane-card';

type ControlPlaneMode = 'managed-by-swarmy' | 'external';

/**
 * Networking → control-plane config (epic #6, Phase 2+). Driver-specific fields:
 * NetBird/Headscale want a management URL + service token. Secrets are write-only — the
 * server stores them encrypted and never returns them.
 */
export function ControlPlaneCard({ driver }: { driver: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const config = useQuery(trpc.mesh.getConfig.queryOptions());

  const [mode, setMode] = React.useState<ControlPlaneMode>('external');
  const [url, setUrl] = React.useState('');
  const [token, setToken] = React.useState('');

  React.useEffect(() => {
    if (config.data) {
      setMode(config.data.controlPlaneMode);
      setUrl(config.data.managementUrl ?? '');
    }
  }, [config.data]);

  const save = useMutation(
    trpc.mesh.setControlPlane.mutationOptions({
      onSuccess: () => {
        toast.success('Control plane saved');
        setToken('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  // NetBird running inside swarmy: the live control-plane card, not a form.
  if (config.data?.controlPlaneMode === 'managed-by-swarmy' && driver === 'netbird') return <SwarmyControlPlaneCard />;

  const needsUrl = driver === 'netbird' || driver === 'headscale';
  const tokenConfigured = !!config.data?.tokenConfigured;

  const tokenLabel = 'Service token';
  const tokenHint = 'NetBird/Headscale Admin API token — stored encrypted, used server-side only.';

  return (
    <Card className="calm-card">
      <CardHeader>
        <CardTitle className="text-base">Control plane</CardTitle>
        <CardDescription>
          Where the mesh coordination lives. Secrets are encrypted at rest and never returned.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
          <>
            {needsUrl && (
              <>
                <div className="grid gap-1.5">
                  <Label className="mono-label">Mode</Label>
                  <Select value={mode} onValueChange={(v) => setMode(v as ControlPlaneMode)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="external">Point at an existing server</SelectItem>
                      <SelectItem value="managed-by-swarmy">Managed by swarmy</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="mono-label" htmlFor="mgmt-url">
                    Management URL
                  </Label>
                  <Input
                    id="mgmt-url"
                    placeholder="https://netbird.example.com"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </div>
              </>
            )}
            <div className="grid gap-1.5">
              <Label className="mono-label" htmlFor="cp-token">
                {tokenLabel}
                {tokenConfigured && (
                  <StatusBadge tone="online" label="configured" className="ml-2 align-middle" />
                )}
              </Label>
              <Input
                id="cp-token"
                type="password"
                placeholder={tokenConfigured ? '•••••• (leave blank to keep)' : 'paste token'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <p className="text-muted-foreground mt-1 text-xs">{tokenHint}</p>
            </div>
            <div className="flex justify-end">
              <Button variant="outline"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({
                    mode,
                    managementUrl: needsUrl ? url || undefined : undefined,
                    serviceToken: token || undefined,
                  })
                }
              >
                Save control plane
              </Button>
            </div>
          </>
      </CardContent>
    </Card>
  );
}
