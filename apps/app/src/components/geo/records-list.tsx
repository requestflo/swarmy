import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { PlusIcon, RouteIcon, Trash2Icon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';
import { AddRecordCard } from './add-record-card';
import { DnsHealthBadge } from './dns-health-badge';

interface RecordRow {
  id: string;
  host: string;
  region: string;
  targetIngress: string;
  healthy: boolean;
}

interface RecordsListProps {
  records: RecordRow[];
  /** Invalidate queries after a mutation. */
  onChange: () => void;
}

/** Flat record rows inside one card-pop, divided by hairlines. */
export function RecordsList({ records, onChange }: RecordsListProps): React.JSX.Element {
  const [addOpen, setAddOpen] = React.useState(false);
  const total = records.length;
  const healthy = records.filter((r) => r.healthy).length;

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
        <CardTitle className="text-base">Records</CardTitle>
        <Button variant="outline" size="sm" onClick={() => setAddOpen((v) => !v)}>
          <PlusIcon className="size-4" /> Add record
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <div className="px-6">
          <AddRecordCard open={addOpen} onOpenChange={setAddOpen} />
        </div>
        {total === 0 ? (
          <div className="px-6 pb-8">
            <EmptyState
              icon={<RouteIcon />}
              title="No records yet"
              description="Map a host to a regional ingress and Geo-DNS starts steering visitors to the nearest healthy region."
              action={
                <Button variant="outline" onClick={() => setAddOpen(true)}>
                  <PlusIcon className="size-4" /> Add record
                </Button>
              }
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
                <RecordRowItem key={r.id} record={r} onChange={onChange} />
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RecordRowItem({ record, onChange }: { record: RecordRow; onChange: () => void }): React.JSX.Element {
  const trpc = useTRPC();
  const removeRecord = useMutation(
    trpc.geodns.removeRecord.mutationOptions({
      onSuccess: () => {
        toast.success(`${record.host} removed`);
        onChange();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="hover:bg-accent/60 flex items-center gap-4 px-6 py-4 transition-colors">
      <div className="min-w-0 flex-1">
        <p className="mono-data truncate font-medium">{record.host}</p>
        <p className="text-muted-foreground mono-label truncate">
          {record.region} · {record.targetIngress}
        </p>
      </div>
      <Badge variant="muted" className="hidden md:inline-flex">
        {record.region}
      </Badge>
      <span className="mono-data text-muted-foreground hidden max-w-[16rem] truncate lg:block">
        {record.targetIngress}
      </span>
      <DnsHealthBadge host={record.host} className="hidden sm:inline-flex" />
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Remove ${record.host}`} disabled={removeRecord.isPending}>
            <Trash2Icon className="size-4" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {record.host}?</AlertDialogTitle>
            <AlertDialogDescription>
              Geo-DNS stops steering this host to {record.region} the moment the zone re-applies.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => removeRecord.mutate({ id: record.id })}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
