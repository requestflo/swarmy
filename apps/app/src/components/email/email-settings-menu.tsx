import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { SettingsIcon } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { emailErrorToast, useEmailMutationHandlers, type EmailOverviewData } from './use-email';

/** Quiet settings: which domain swarmy's own mail uses, body logging, inbound reports, off. */
export function EmailSettingsMenu({ overview: o }: { overview: EmailOverviewData }): React.JSX.Element {
  const trpc = useTRPC();
  const handlers = useEmailMutationHandlers('Saved');
  const settings = useMutation(trpc.email.setSettings.mutationOptions(handlers));
  const disable = useMutation(trpc.email.setEnabled.mutationOptions(useEmailMutationHandlers('Email service turned off')));
  const inbound = useMutation(
    trpc.email.setInbound.mutationOptions({
      onSuccess: (r) => {
        if (r.token) toast.success(`Forward bounce/complaint reports to ${r.url} with "Authorization: Bearer ${r.token}" — shown once.`, { duration: 60_000 });
        else toast.success('Inbound reports turned off');
      },
      onError: emailErrorToast,
    }),
  );
  const verified = o.domains.filter((d) => d.verifiedAt);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Email settings">
          <SettingsIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>swarmy’s own mail sends from</DropdownMenuLabel>
        {verified.length === 0 ? (
          <DropdownMenuItem disabled>No verified domain yet</DropdownMenuItem>
        ) : (
          verified.map((d) => (
            <DropdownMenuCheckboxItem
              key={d.id}
              checked={d.isSystem || (!o.systemDomainId && d.id === verified[0]!.id)}
              onCheckedChange={() => settings.mutate({ systemDomainId: d.id })}
            >
              noreply@{d.domain}
            </DropdownMenuCheckboxItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={o.logBodies} onCheckedChange={(v) => settings.mutate({ logBodies: Boolean(v) })}>
          Keep message bodies in the send log
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem onSelect={() => inbound.mutate({ enabled: true })}>
          {o.inboundEnabled ? 'Rotate the inbound report token' : 'Accept forwarded bounce reports'}
        </DropdownMenuItem>
        {o.inboundEnabled ? <DropdownMenuItem onSelect={() => inbound.mutate({ enabled: false })}>Stop accepting inbound reports</DropdownMenuItem> : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-status-offline" onSelect={() => {
            if (window.confirm('Turn off email? The mail server stops and apps can no longer send; queued mail is kept for when you turn it back on.')) disable.mutate({ enabled: false });
          }}>
          Turn off the email service
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
