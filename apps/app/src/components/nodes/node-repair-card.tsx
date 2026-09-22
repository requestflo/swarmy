import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { RefreshCwIcon, WrenchIcon } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, CopyButton, toast } from '@swarmy/ui';
import type { NodeDetail } from '@swarmy/core';
import {
  ControllerUrlWarning,
  installOneLiner,
  type InstallTarget,
  type MeshSetupKey,
} from '@/components/onboarding/install-command-panel';
import { useTRPC } from '@/integrations/trpc';

/**
 * Repair tokens live a day: a repair often means several attempts across a
 * flaky box, and a token that expires mid-attempt is exactly how the old
 * flow failed. Still single-use-when-mesh (enforced server-side).
 */
const REPAIR_TOKEN_TTL_SECONDS = 24 * 60 * 60;

function expiresIn(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 90 ? `in ${m}m` : `in ${Math.round(m / 60)}h`;
}

interface Issued {
  token: string;
  expiresAt: number;
  mesh: MeshSetupKey | null;
  target: InstallTarget | null;
}

/**
 * "Repair this node" — shown on OFFLINE nodes. Mints a FRESH join token
 * (+ mesh setup key when the org has mesh enabled) on demand and renders the
 * SAME one-liner as Add-a-node: on an already-enrolled box the installer
 * detects the existing install, switches to repair mode (refresh binary +
 * credentials, keep identity), and runs `doctor --repair`. The controller
 * re-adopts the node by hostname, so no duplicate node is created. The command
 * is withdrawn once its token expires — mint another rather than paste a dead one.
 */
export function NodeRepairCard({ node }: { node: NodeDetail | undefined }): React.JSX.Element | null {
  const trpc = useTRPC();
  const [issued, setIssued] = React.useState<Issued | null>(null);
  const [now, setNow] = React.useState(() => Date.now());

  // Tick so an expired command disappears on its own.
  React.useEffect(() => {
    if (!issued) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [issued]);

  const generate = useMutation(
    trpc.nodes.generateJoinToken.mutationOptions({
      onSuccess: (res) => {
        setNow(Date.now());
        setIssued({
          token: res.token,
          expiresAt: new Date(res.expiresAt).getTime(),
          mesh: res.meshSetupKey
            ? { setupKey: res.meshSetupKey, managementUrl: res.meshManagementUrl, driver: res.meshDriver }
            : null,
          target: res.install ?? null,
        });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (!node || node.status === 'online') return null;

  const live = issued && issued.expiresAt > now ? issued : null;
  const oneLiner = live ? installOneLiner(live.token, '', 'auto', live.mesh, live.target) : null;
  const mint = (): void =>
    generate.mutate({ label: `repair:${node.hostname}`, ttlSeconds: REPAIR_TOKEN_TTL_SECONDS });

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
          <div className="grid gap-1.5">
            <div>
              <Button size="sm" variant="outline" disabled={generate.isPending} onClick={mint}>
                {generate.isPending ? 'Minting…' : 'Generate repair command'}
              </Button>
            </div>
            {issued ? (
              <span className="text-muted-foreground text-xs">
                The previous repair command expired — generate a fresh one.
              </span>
            ) : null}
          </div>
        ) : (
          <>
            <div className="bg-muted/50 mono-data overflow-x-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap">
              {oneLiner}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton value={oneLiner} label="Copy" />
              <Button size="sm" variant="ghost" disabled={generate.isPending} onClick={mint}>
                <RefreshCwIcon className="size-3.5" />
                New command
              </Button>
              <span className="text-muted-foreground text-xs">
                Run it on {node.hostname}. Fresh token, expires {expiresIn(live!.expiresAt - now)}.
              </span>
            </div>
            <ControllerUrlWarning target={live?.target} />
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
