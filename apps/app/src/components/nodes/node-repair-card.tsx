import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { WrenchIcon } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, CopyButton, toast } from '@swarmy/ui';
import type { NodeDetail } from '@swarmy/core';
import { installOneLiner, type MeshSetupKey } from '@/components/onboarding/install-command-panel';
import { useTRPC } from '@/integrations/trpc';

/**
 * "Repair this node" — shown on OFFLINE nodes. Mints a fresh join token
 * (+ mesh setup key when the org has mesh enabled) and renders the SAME
 * one-liner as Add-a-node: on an already-enrolled box the installer detects
 * the existing install, switches to repair mode (refresh binary + credentials,
 * keep identity), and runs `doctor --repair`. The controller re-adopts the
 * node by hostname + token binding, so no duplicate node is created.
 */
export function NodeRepairCard({ node }: { node: NodeDetail | undefined }): React.JSX.Element | null {
  const trpc = useTRPC();
  const [token, setToken] = React.useState<string | null>(null);
  const [mesh, setMesh] = React.useState<MeshSetupKey | null>(null);

  const generate = useMutation(
    trpc.nodes.generateJoinToken.mutationOptions({
      onSuccess: (res) => {
        setToken(res.token);
        setMesh(
          res.meshSetupKey
            ? { setupKey: res.meshSetupKey, managementUrl: res.meshManagementUrl, driver: res.meshDriver }
            : null,
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (!node || node.status === 'online') return null;

  const oneLiner = token ? installOneLiner(token, '', 'auto', mesh) : null;

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <WrenchIcon className="size-4" />
          Repair this node
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p className="text-muted-foreground">
          {node.name} is offline. If the machine is up but won&apos;t reconnect, paste a repair one-liner on it — the
          installer detects the existing install, refreshes its credentials, keeps its identity, and runs the doctor.
        </p>
        {oneLiner === null ? (
          <div>
            <Button size="sm" variant="outline" disabled={generate.isPending} onClick={() => generate.mutate({ label: `repair:${node.hostname}` })}>
              {generate.isPending ? 'Minting…' : 'Generate repair command'}
            </Button>
          </div>
        ) : (
          <>
            <div className="bg-muted/50 mono-data overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap break-all">
              {oneLiner}
            </div>
            <div className="flex items-center gap-2">
              <CopyButton value={oneLiner} label="Copy" />
              <span className="text-muted-foreground text-xs">
                Run it on {node.hostname} (swap localhost for this controller&apos;s reachable address). Shown once.
              </span>
            </div>
          </>
        )}
        <p className="text-muted-foreground text-xs">
          On the box itself you can also run <span className="mono-data">swarmy-agent doctor --fix</span> for
          diagnostics without new credentials.
        </p>
      </CardContent>
    </Card>
  );
}
