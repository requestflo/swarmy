import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheckIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusBadge,
  type StatusTone,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

function restoreTone(status: string): StatusTone {
  switch (status.toUpperCase()) {
    case 'SUCCEEDED':
      return 'online';
    case 'RUNNING':
      return 'progress';
    case 'QUEUED':
      return 'progress';
    case 'FAILED':
      return 'offline';
    default:
      return 'neutral';
  }
}

/**
 * DR settings + restore-on-recovery history. The dr-reconcile worker writes
 * RestoreOperation rows when a node dies; we surface them here so users can see
 * automatic recoveries (and their RPO/RTO in practice).
 */
export function DrRecoveryList(): React.JSX.Element {
  const trpc = useTRPC();
  const restores = useQuery(trpc.schedules.listRestores.queryOptions());
  const rows = restores.data ?? [];

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Disaster recovery</CardTitle>
        <CardDescription>
          When a node drops past the grace window, swarmy restores its stranded volumes to a healthy
          node automatically. Recent recoveries:
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyState
              icon={<ShieldCheckIcon />}
              title="No recoveries yet"
              description="That is a good thing — your fleet has stayed healthy. Restores show up here the moment swarmy steps in."
              className="border-0"
            />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_auto] gap-x-4 px-6 pb-2 sm:grid-cols-[2fr_1.5fr_auto]">
              <span className="mono-label">Volume</span>
              <span className="mono-label hidden sm:block">Restored to</span>
              <span className="mono-label text-right">Status</span>
            </div>
            <div className="border-t">
              {rows.map((r) => (
                <div
                  key={r.id}
                  className="hover:bg-accent/60 grid grid-cols-[1fr_auto] items-center gap-x-4 border-b px-6 py-3 transition-colors last:border-b-0 sm:grid-cols-[2fr_1.5fr_auto]"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{r.targetVolume}</p>
                    <p className="text-muted-foreground mono-label truncate">
                      {r.reason} · {new Date(r.startedAt).toLocaleString()}
                    </p>
                  </div>
                  <span className="mono-data text-muted-foreground hidden truncate sm:block">
                    {r.targetNodeId ? r.targetNodeId.slice(0, 8) : 'unassigned'}
                  </span>
                  <div className="flex justify-end">
                    <StatusBadge tone={restoreTone(r.status)} label={r.status.toLowerCase()} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
