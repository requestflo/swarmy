import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const STATUS_TONE: Record<string, 'default' | 'muted' | 'destructive'> = {
  SUCCEEDED: 'default',
  RUNNING: 'muted',
  QUEUED: 'muted',
  FAILED: 'destructive',
};

/**
 * DR settings + restore-on-recovery history. The dr-reconcile worker writes
 * RestoreOperation rows when a node dies; we surface them here so users can see
 * automatic recoveries (and their RPO/RTO in practice).
 */
export function DrSettingsCard(): React.JSX.Element {
  const trpc = useTRPC();
  const restores = useQuery(trpc.schedules.listRestores.queryOptions());
  const rows = restores.data ?? [];

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Disaster recovery</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <p className="text-muted-foreground px-6 pb-4 text-sm">
          When a node goes offline past the grace window, swarmy restores its stranded volumes to a
          healthy node automatically. Recent recoveries:
        </p>
        <div className="border-t">
          {rows.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-4 border-b px-6 py-3 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="font-medium">{r.targetVolume}</p>
                <p className="text-muted-foreground mono-label truncate">
                  {r.reason} · {r.targetNodeId ? r.targetNodeId.slice(0, 8) : 'unassigned'} ·{' '}
                  {new Date(r.startedAt).toLocaleString()}
                </p>
              </div>
              <Badge variant={STATUS_TONE[r.status] ?? 'muted'}>{r.status.toLowerCase()}</Badge>
            </div>
          ))}
          {rows.length === 0 ? (
            <div className="text-muted-foreground px-6 py-12 text-center text-sm">
              No recoveries yet. That is a good thing.
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
