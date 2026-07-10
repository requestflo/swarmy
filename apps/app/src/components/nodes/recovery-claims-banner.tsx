import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlertIcon } from 'lucide-react';
import { Badge, Button, Card, CardContent, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Recovery beacon approvals (self-healing epic). A node that lost every
 * credential posts a claim and prints a FINGERPRINT in its journal
 * (`journalctl -u swarmy-agent`). Approve here only after the fingerprints
 * match — this is the SSH-host-key trust ritual, and the copy says so.
 */
export function RecoveryClaimsBanner(): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const claims = useQuery(trpc.nodes.recoveryClaims.queryOptions(undefined, { refetchInterval: 10_000 }));
  const resolve = useMutation(
    trpc.nodes.resolveRecoveryClaim.mutationOptions({
      onSuccess: (r) => {
        toast.success(r.status === 'approved' ? 'Claim approved — the node reconnects within ~15s' : 'Claim denied');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const pending = claims.data ?? [];
  if (pending.length === 0) return null;

  return (
    <Card className="card-pop border-amber-500/40 border">
      <CardContent className="grid gap-3 pt-4 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <ShieldAlertIcon className="size-4 text-amber-500" />
          {pending.length === 1 ? 'A machine is asking to reconnect' : `${pending.length} machines are asking to reconnect`}
        </div>
        {pending.map((claim) => (
          <div key={claim.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 p-3">
            <div className="grid gap-1">
              <span className="font-medium">{claim.hostname}</span>
              <span className="text-muted-foreground text-xs">
                Fingerprint <Badge variant="outline" className="mono-data">{claim.fingerprint}</Badge> — approve ONLY if
                this matches what the machine printed (<span className="mono-data">journalctl -u swarmy-agent</span>).
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ id: claim.id, approve: false })}
              >
                Deny
              </Button>
              <Button
                size="sm"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ id: claim.id, approve: true })}
              >
                Approve
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
