import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScrollTextIcon } from 'lucide-react';
import { EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Recent gateway requests (rows exist only while the audit toggle is on). */
export function RequestLogCard(): React.JSX.Element {
  const trpc = useTRPC();
  const logs = useQuery({ ...trpc.ai.logs.queryOptions({ limit: 50 }), refetchInterval: 10_000 });
  const rows = logs.data ?? [];

  return (
    <div className="card-pop p-5">
      <p className="font-semibold">Request log</p>
      <p className="text-muted-foreground text-xs">
        Per-request rows with a 200-char redacted prompt — written only while the audit toggle is
        on.
      </p>

      {logs.isLoading ? (
        <div className="mt-4 space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer-line h-8 rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-2">
          <EmptyState
            icon={<ScrollTextIcon />}
            title="No logged requests"
            description="Flip on the request audit log in Gateway settings and every call through the gateway shows up here."
          />
        </div>
      ) : (
        <Table className="mt-3">
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="hidden md:table-cell">Tokens</TableHead>
              <TableHead>Cost (est.)</TableHead>
              <TableHead className="hidden sm:table-cell">Latency</TableHead>
              <TableHead className="hidden lg:table-cell">Prompt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-muted-foreground text-xs">
                  {new Date(r.at).toLocaleTimeString()}
                </TableCell>
                <TableCell className="mono-data text-xs">{r.keyName}</TableCell>
                <TableCell className="mono-data text-xs">
                  {r.model}
                  {r.cacheHit ? <span className="text-status-progress ml-1">· cached</span> : null}
                  {r.status !== 'ok' ? (
                    <span className="text-status-offline ml-1">· {r.status}</span>
                  ) : null}
                </TableCell>
                <TableCell className="mono-data hidden text-xs md:table-cell">
                  {r.inTokens}→{r.outTokens}
                </TableCell>
                <TableCell className="mono-data text-xs">${r.costUsd.toFixed(4)}</TableCell>
                <TableCell className="mono-data hidden text-xs sm:table-cell">{r.latencyMs}ms</TableCell>
                <TableCell className="text-muted-foreground hidden max-w-[280px] truncate text-xs lg:table-cell">
                  {r.promptRedacted ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
