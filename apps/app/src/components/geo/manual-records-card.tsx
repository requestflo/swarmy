import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { DnsRecordView, DnsZoneView } from './geo-types';
import { ManualRecordForm } from './manual-record-form';

/** Manual zone content (MX, TXT, CNAME, SRV, CAA, NS…) — web records derive. */
export function ManualRecordsCard({ zone }: { zone: DnsZoneView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = React.useState(false);
  const records = useQuery(trpc.geodns.listRecords.queryOptions({ zoneId: zone.id }));

  const removeRecord = useMutation(
    trpc.geodns.removeRecord.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = records.data ?? [];

  return (
    <Card className="card-pop border-0">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">
            Manual records · <span className="mono-data">{zone.zone}</span>
          </CardTitle>
          <CardDescription>
            Mail, verification and service records. Web A records derive from ingress — you never
            add those here.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setAddOpen((v) => !v)}>
          <PlusIcon className="size-4" /> Add record
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {addOpen ? (
          <div className="px-6 pb-4">
            <ManualRecordForm zoneId={zone.id} onDone={() => setAddOpen(false)} />
          </div>
        ) : null}
        {rows.length === 0 ? (
          <p className="text-muted-foreground px-6 pb-6 text-sm">
            No manual records yet — MX for mail, TXT for verification, they all go here.
          </p>
        ) : (
          <div className="divide-border divide-y border-t">
            {rows.map((r) => (
              <RecordRow
                key={r.id}
                record={r}
                onRemove={() => removeRecord.mutate({ id: r.id })}
                removing={removeRecord.isPending}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecordRow({
  record,
  onRemove,
  removing,
}: {
  record: DnsRecordView;
  onRemove: () => void;
  removing: boolean;
}): React.JSX.Element {
  return (
    <div className="hover:bg-accent/40 flex items-center gap-3 px-6 py-3 transition-colors">
      <Badge variant="muted" className="w-14 justify-center">
        {record.type}
      </Badge>
      <span className="mono-data w-28 shrink-0 truncate font-medium">{record.name}</span>
      <span className="mono-data text-muted-foreground min-w-0 flex-1 truncate">{record.value}</span>
      {record.priority != null ? (
        <span className="mono-label text-muted-foreground hidden shrink-0 sm:inline">
          prio {record.priority}
        </span>
      ) : null}
      <span className="mono-label text-muted-foreground hidden shrink-0 sm:inline">
        {record.ttl != null ? `${record.ttl}s` : 'zone ttl'}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-status-offline"
        onClick={onRemove}
        disabled={removing}
        aria-label={`Remove ${record.type} ${record.name}`}
      >
        <Trash2Icon className="size-4" />
      </Button>
    </div>
  );
}
