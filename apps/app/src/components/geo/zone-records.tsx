import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import { Button, cn, toast } from '@swarmy/ui';
import { Depth, Section, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { DnsRecordView, DnsViewRow, DnsZoneView } from './geo-types';
import { mergeRecords, type RecordLine } from './zone-records-model';
import { RecordAddRow } from './record-add-row';

const ROW = 'border-border grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b px-1 py-2 font-mono text-[12px] last:border-b-0 sm:grid-cols-[56px_minmax(0,160px)_minmax(0,1fr)_auto_auto]';

/**
 * One table for the zone: the web records swarmy derives from your addresses
 * (never stored, so nothing to edit) and the ones you added — mail,
 * verification, CAA. Adding and removing are at Controls.
 */
export function ZoneRecords({ zone, rows, records, ready, nameOf }: {
  zone: DnsZoneView;
  rows: DnsViewRow[];
  records: DnsRecordView[];
  ready: boolean;
  nameOf: (ip: string) => string;
}): React.JSX.Element {
  const lines = mergeRecords(zone.zone, rows, records, nameOf);
  const yours = lines.filter((l) => l.source === 'you').length;
  return (
    <Section title="Records" count={ready ? lines.length : undefined} hint="Web records are automatic. Add mail, verification and CAA here.">
      {!ready ? (
        <div className="shimmer-line h-24 rounded-md" aria-hidden />
      ) : lines.length === 0 ? (
        <p className="text-muted-foreground text-[13.5px]">No records yet. Give an app an address under {zone.zone} and its web record appears here by itself.</p>
      ) : (
        <div role="table" aria-label={`Records in ${zone.zone}`} className="flex flex-col">
          {lines.map((l) => (
            <RecordRow key={l.key} line={l} />
          ))}
        </div>
      )}
      <Depth at="controls">
        <RecordAddRow zoneId={zone.id} />
      </Depth>
      <Tech>
        automatic = composed from ingress routes, status pages, webhooks and AI outlets at serve time · {yours} manual DnsRecord row{yours === 1 ? '' : 's'} · zone TTL {zone.ttl}s
      </Tech>
    </Section>
  );
}

function RecordRow({ line: l }: { line: RecordLine }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const remove = useMutation(
    trpc.geodns.removeRecord.mutationOptions({
      onSuccess: () => {
        toast.success(`${l.type} ${l.name} removed`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const auto = l.source === 'automatic';
  return (
    <div role="row" className={ROW}>
      <span role="cell" className="text-primary font-semibold">{l.type}</span>
      <span role="cell" className="truncate font-semibold" title={l.name}>{l.name}</span>
      <span role="cell" className={cn('col-start-2 row-start-2 truncate sm:col-start-auto sm:row-start-auto', auto ? 'text-muted-foreground' : '')} title={l.value}>
        {l.value}
      </span>
      <span role="cell" className={cn('col-start-3 row-start-1 justify-self-end rounded-full px-2 py-0.5 text-[11px] font-semibold sm:col-start-auto sm:row-start-auto', auto ? 'bg-status-online/15 text-tone-ok' : 'bg-muted text-muted-foreground')}>
        {auto ? 'automatic' : 'you'}
      </span>
      <span role="cell" className="col-start-3 row-start-2 justify-self-end sm:col-start-auto sm:row-start-auto">
        {l.id ? (
          <Depth at="controls">
            <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-tone-bad size-8 pointer-coarse:size-11" disabled={remove.isPending} onClick={() => remove.mutate({ id: l.id! })} aria-label={`Remove ${l.type} ${l.name}`}>
              <Trash2Icon className="size-4" />
            </Button>
          </Depth>
        ) : null}
      </span>
    </div>
  );
}
