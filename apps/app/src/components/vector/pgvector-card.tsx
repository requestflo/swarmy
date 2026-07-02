import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseIcon } from 'lucide-react';
import { Badge, Button, StatusBadge, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * pgvector enablement: list managed Postgres clusters, one-click
 * `CREATE EXTENSION IF NOT EXISTS vector` on the primary. Apps keep using
 * their injected DATABASE_URL — no separate attach step.
 */
export function PgvectorCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const clusters = useQuery({ ...trpc.vector.pgvector.queryOptions(), refetchInterval: 10_000 });
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
    <div className="card-pop p-5">
      <div className="flex items-center gap-3">
        <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
          <DatabaseIcon className="size-5" />
        </span>
        <div>
          <p className="font-semibold">pgvector on managed Postgres</p>
          <p className="text-muted-foreground text-xs">
            Already running a managed database? Enable the vector extension in place — apps use
            their existing DATABASE_URL, nothing new to attach.
          </p>
        </div>
      </div>

      {clusters.isLoading ? (
        <div className="mt-4 space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="shimmer-line h-9 rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground mt-4 text-sm">
          No managed Postgres clusters yet — provision one from a stack&apos;s Databases panel
          first, then enable pgvector here.
        </p>
      ) : (
        <div className="divide-border mt-3 divide-y">
          {rows.map((c) => (
            <div key={`${c.stack}/${c.cluster}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
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
