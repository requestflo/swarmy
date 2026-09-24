import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { MoreHorizontalIcon } from 'lucide-react';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { EditDeliveryDialog } from './edit-delivery-dialog';
import { useEmailMutationHandlers, type EmailDomainData } from './use-email';

const POLICIES = ['none', 'quarantine', 'reject'] as const;

/** Per-domain actions: delivery path, DMARC policy, rotate DKIM, remove. */
export function DomainActions({ domain: d }: { domain: EmailDomainData }): React.JSX.Element {
  const trpc = useTRPC();
  const [editing, setEditing] = React.useState(false);
  const update = useMutation(trpc.email.updateDomain.mutationOptions(useEmailMutationHandlers('Saved')));
  const rotate = useMutation(trpc.email.rotateDkim.mutationOptions(useEmailMutationHandlers('New DKIM key — publish its record')));
  const remove = useMutation(trpc.email.removeDomain.mutationOptions(useEmailMutationHandlers('Domain removed')));
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${d.domain}`}>
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>Change delivery (direct / relay)…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>DMARC policy</DropdownMenuLabel>
          {POLICIES.map((p) => (
            <DropdownMenuItem key={p} disabled={d.dmarcPolicy === p} onSelect={() => update.mutate({ id: d.id, dmarcPolicy: p })}>
              {p === d.dmarcPolicy ? `✓ ${p}` : p}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              if (window.confirm(`Rotate the DKIM key for ${d.domain}? Sending pauses until the new record is published.`)) rotate.mutate({ id: d.id });
            }}
          >
            Rotate DKIM key
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-status-offline"
            onSelect={() => {
              if (window.confirm(`Remove ${d.domain}? Apps can no longer send from it.`)) remove.mutate({ id: d.id });
            }}
          >
            Remove domain
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <EditDeliveryDialog domain={d} open={editing} onOpenChange={setEditing} />
    </>
  );
}
