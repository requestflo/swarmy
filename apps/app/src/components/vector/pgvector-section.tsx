import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, StatusBadge, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * pgvector enablement rows: the stack's managed Postgres clusters with a
 * one-click `CREATE EXTENSION IF NOT EXISTS vector` on the primary. Apps keep
 * using their injected DATABASE_URL — no separate attach step. Renders as a
 * flat subsection inside the Vector card (no card of its own).
 */
export function PgvectorSection({ stack }: { stack?: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const clusters = useQuery({
    ...trpc.vector.pgvector.queryOptions(stack ? { stack } : undefined),
    refetchInterval: 10_000,
  });
  const enable = useMutation(
    trpc.vector.enablePgvector.mutationOptions({
      onSuccess: (r) => {
        toast.success(`pgvector enabled on ${r.stack}/${r.cluster}`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = clusters.data ?? [];

  return (
    <div className="border-border border-t pt-4">
      <p className="font-medium">pgvector on managed Postgres</p>
      <p className="text-muted-foreground text-xs">
        Already running a managed database? Enable the vector extension in place — apps use their
        existing DATABASE_URL, nothing new to attach.
      </p>

      {clusters.isLoading ? (
        <div className="mt-3 space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="shimmer-line h-9 rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground mt-3 text-sm">
          No managed Postgres clusters here yet — provision one from the Databases panel above,
          then enable pgvector in place.
        </p>
      ) : (
        <div className="divide-border mt-2 divide-y">
          {rows.map((c) => (
            <div
              key={`${c.stack}/${c.cluster}`}
              className="flex flex-wrap items-center justify-between gap-2 py-2.5"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="min-w-0">
                  <p className="mono-data truncate text-sm">
                    {c.stack}/{c.cluster}
                  </p>
                  <p className="text-muted-foreground text-xs">{c.primaryService}</p>
                </div>
                <StatusBadge
                  tone={c.status === 'running' ? 'online' : c.status === 'deploying' ? 'progress' : 'offline'}
                  label={c.status}
                />
              </div>
              {c.enabled ? (
                <Badge variant="secondary">pgvector enabled</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={enable.isPending || c.status !== 'running'}
                  onClick={() => enable.mutate({ stack: c.stack, cluster: c.cluster })}
                >
                  {enable.isPending ? 'Enabling…' : 'Enable pgvector'}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
