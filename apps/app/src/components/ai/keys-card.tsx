import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon } from 'lucide-react';
import type { AiKeyMintResult } from '@swarmy/core';
import { Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { KeyRevealBanner } from './key-reveal-banner';
import { MintKeyCard } from './mint-key-card';

/** Virtual keys table: inline mint form, REVEAL-ONCE banner, limits, revoke. */
export function KeysCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [reveal, setReveal] = React.useState<AiKeyMintResult | null>(null);
  const keys = useQuery({ ...trpc.ai.keys.queryOptions(), refetchInterval: 10_000 });
  const revoke = useMutation(
    trpc.ai.revokeKey.mutationOptions({
      onSuccess: () => {
        toast.success('Key revoked');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = keys.data ?? [];

  return (
    <div className="card-pop p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">Virtual keys</p>
          <p className="text-muted-foreground text-xs">
            Hand these to apps instead of provider keys — each with its own rate limit and budget.
          </p>
        </div>
        <MintKeyCard onMinted={setReveal} />
      </div>

      {reveal ? (
        <div className="mt-4">
          <KeyRevealBanner
            keyValue={reveal.key}
            gatewayUrl={reveal.gatewayUrl}
            onDismiss={() => setReveal(null)}
          />
        </div>
      ) : null}

      {keys.isLoading ? (
        <div className="mt-4 space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="shimmer-line h-9 rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-2">
          <EmptyState
            icon={<KeyRoundIcon />}
            title="No keys yet — mint one."
            description="A virtual key is shown once, then stored only as a hash. Revoke it any time without touching your provider keys."
          />
        </div>
      ) : (
        <Table className="mt-3">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden sm:table-cell">Limits</TableHead>
              <TableHead>30d requests</TableHead>
              <TableHead>30d cost (est.)</TableHead>
              <TableHead className="hidden sm:table-cell">Created</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((k) => (
              <TableRow key={k.id} className={k.disabled ? 'opacity-50' : undefined}>
                <TableCell>
                  <span className="mono-data text-xs">{k.name}</span>
                  {k.appRef ? (
                    <span className="text-muted-foreground ml-2 text-xs">→ {k.appRef}</span>
                  ) : null}
                  {k.disabled ? (
                    <span className="text-status-offline ml-2 text-xs">revoked</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-muted-foreground hidden text-xs sm:table-cell">
                  {k.limits.rpm ? `${k.limits.rpm} rpm` : 'no rpm cap'}
                  {' · '}
                  {k.limits.dailyBudgetUsd ? `$${k.limits.dailyBudgetUsd}/day` : 'no budget'}
                </TableCell>
                <TableCell className="mono-data text-xs">{k.usage30d.requests}</TableCell>
                <TableCell className="mono-data text-xs">${k.usage30d.costUsd.toFixed(2)}</TableCell>
                <TableCell className="text-muted-foreground hidden text-xs sm:table-cell">
                  {new Date(k.createdAt).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-right">
                  {!k.disabled ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-status-offline"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate({ id: k.id })}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
