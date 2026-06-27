import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { RouteIcon, Trash2Icon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import { AddRecordDialog } from './add-record-dialog';

interface RecordRow {
  id: string;
  host: string;
  region: string;
  targetIngress: string;
  healthy: boolean;
}

interface RecordsListProps {
  records: RecordRow[];
  /** Invalidate queries after a mutation (mirrors the page invalidate). */
  onChange: () => void;
}

/** Flat record rows inside one card-pop, divided by hairlines. */
export function RecordsList({ records, onChange }: RecordsListProps): React.JSX.Element {
  const trpc = useTRPC();

  const removeRecord = useMutation(
    trpc.geodns.removeRecord.mutationOptions({
      onSuccess: onChange,
      onError: (e) => toast.error(e.message),
    }),
  );

  const total = records.length;
  const healthy = records.filter((r) => r.healthy).length;

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Records</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {total === 0 ? (
          <div className="px-6 pb-8">
            <EmptyState
              icon={<RouteIcon />}
              title="No records yet"
              description="Map a host to a regional ingress and Geo-DNS starts steering visitors to the nearest healthy region."
              action={<AddRecordDialog onDone={onChange} variant="outline" />}
            />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 px-6 py-4">
              <span className="mono-label">
                <CountUp value={healthy} /> / {total} healthy
              </span>
              <span className="text-muted-foreground mono-label">{total} steered</span>
            </div>
            <div className="divide-border divide-y border-t">
              {records.map((r) => (
                <div
                  key={r.id}
                  className="hover:bg-accent/60 flex items-center gap-4 px-6 py-4 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="mono-data truncate font-medium">{r.host}</p>
                    <p className="text-muted-foreground mono-label truncate">
                      {r.region} · {r.targetIngress}
                    </p>
                  </div>
                  <Badge variant="muted" className="hidden md:inline-flex">
                    {r.region}
                  </Badge>
                  <span className="mono-data text-muted-foreground hidden max-w-[16rem] truncate lg:block">
                    {r.targetIngress}
                  </span>
                  <StatusBadge
                    tone={r.healthy ? 'online' : 'offline'}
                    label={r.healthy ? 'healthy' : 'down'}
                    className="hidden sm:inline-flex"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${r.host}`}
                    onClick={() => removeRecord.mutate({ id: r.id })}
                    disabled={removeRecord.isPending}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
