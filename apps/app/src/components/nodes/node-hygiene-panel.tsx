import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SparklesIcon } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;

/**
 * Disk cleanup on this node: what swarmy prunes automatically (every 6h, or
 * sooner when the disk passes 85%), the recent runs ("reclaimed X GB"), and a
 * "Clean up now" button. Settings are node labels (swarmy.hygiene.*).
 */
export function NodeHygienePanel({ nodeId }: { nodeId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const hygiene = useQuery({ ...trpc.nodes.hygiene.queryOptions({ nodeId }), refetchInterval: 60_000 });
  const run = useMutation(
    trpc.nodes.runHygiene.mutationOptions({
      onSuccess: (r) => {
        if (r.ok) toast.success(r.summary);
        else toast.error(r.summary);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const s = hygiene.data?.settings;
  const runs = hygiene.data?.runs ?? [];

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <SparklesIcon className="text-primary size-4" /> Disk cleanup
        </CardTitle>
        <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate({ nodeId })}>
          {run.isPending ? 'Cleaning up…' : 'Clean up now'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">
          {s && !s.enabled
            ? 'Automatic cleanup is off for this node (label swarmy.hygiene.enabled=false).'
            : `Every 6 hours (sooner above 85% disk) swarmy removes stopped one-off containers, images nothing has used for ${
                s?.imageMinAgeDays ?? 7
              } days, and build cache over ${gb(s?.buildCacheKeepBytes ?? 5 * 1024 ** 3)}. It never touches an image a running service or the previous release uses.`}
        </p>
        {runs.length === 0 ? (
          <p className="text-muted-foreground text-xs">No cleanup has run on this node yet.</p>
        ) : (
          <div className="divide-border grid grid-cols-1 divide-y">
            {runs.map((r) => (
              <div key={r.at} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                <span className={r.ok ? '' : 'text-destructive'}>{r.summary}</span>
                <span className="mono-data text-muted-foreground text-xs">
                  {new Date(r.at).toLocaleString()} · {r.automatic ? 'automatic' : 'manual'}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
