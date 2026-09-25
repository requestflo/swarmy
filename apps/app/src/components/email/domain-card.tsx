import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { RefreshCwIcon } from 'lucide-react';
import { Button, StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DnsRecordsTable } from './dns-records-table';
import { DomainActions } from './domain-actions';
import { useEmailMutationHandlers, type EmailDomainData } from './use-email';

function dnsLine(d: EmailDomainData): string {
  if (d.dns.mode === 'swarmy') {
    return d.dns.delegated
      ? `Published by swarmy DNS (zone ${d.dns.zone}).`
      : `swarmy DNS will publish these once ${d.dns.zone} is delegated to swarmy.`;
  }
  return 'This domain’s DNS is hosted elsewhere — add these records at your DNS provider.';
}

/** One sending domain: verification, delivery path, and every DNS record's live status. */
export function DomainCard({ domain: d }: { domain: EmailDomainData }): React.JSX.Element {
  const trpc = useTRPC();
  const check = useMutation(trpc.email.checkDomain.mutationOptions(useEmailMutationHandlers()));
  const pending = d.records.filter((r) => r.status !== 'ok').length;
  return (
    <div className="calm-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="mono-data truncate text-base font-semibold">{d.domain}</p>
            {d.verifiedAt ? <StatusBadge tone="online" label="Verified" /> : <StatusBadge tone="warning" label="Waiting for DKIM record" />}
            <span className="bg-muted rounded-full px-2 py-0.5 text-xs">
              {d.delivery === 'relay' ? `Relay · ${d.relay?.host ?? '?'}` : 'Direct delivery'}
            </span>
            {d.isSystem ? <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs">swarmy’s own mail</span> : null}
          </div>
          <p className="text-muted-foreground text-xs">
            {dnsLine(d)} {d.checkedAt ? `Checked ${new Date(d.checkedAt).toLocaleTimeString()}.` : 'Not checked yet.'}
            {pending > 0 && d.checkedAt ? ` ${pending} record${pending === 1 ? '' : 's'} to fix.` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={check.isPending} onClick={() => check.mutate({ id: d.id })}>
            <RefreshCwIcon className={check.isPending ? 'size-4 animate-spin' : 'size-4'} /> Check DNS
          </Button>
          <DomainActions domain={d} />
        </div>
      </div>
      <DnsRecordsTable records={d.records} checked={Boolean(d.checkedAt)} />
    </div>
  );
}
