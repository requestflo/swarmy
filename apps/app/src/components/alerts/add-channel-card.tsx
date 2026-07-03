import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ChannelConfigInput, NotificationChannelKindView } from '@swarmy/core';
import { Button, Collapsible, CollapsibleContent, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ChannelDestinationFields } from './channel-destination-fields';
import { ChannelKindPicker } from './channel-kind-picker';

interface AddChannelCardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Inline expanding card: add a notification channel (email, or a slack/teams/webhook URL). */
export function AddChannelCard({ open, onOpenChange }: AddChannelCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<NotificationChannelKindView>('email');
  const [to, setTo] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [secret, setSecret] = React.useState('');

  const reset = (): void => {
    setName('');
    setKind('email');
    setTo('');
    setUrl('');
    setSecret('');
  };
  const create = useMutation(
    trpc.alerts.createChannel.mutationOptions({
      onSuccess: (c) => {
        toast.success(`Channel ${c.name} added — send it a test.`);
        onOpenChange(false);
        reset();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const config: ChannelConfigInput | null =
    kind === 'email'
      ? to.trim()
        ? { kind, to: to.trim() }
        : null
      : url.trim()
        ? kind === 'webhook'
          ? { kind, url: url.trim(), ...(secret.trim() ? { secret: secret.trim() } : {}) }
          : { kind, url: url.trim() }
        : null;
  const ready = Boolean(name.trim() && config);

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleContent>
        <div className="card-pop mb-3 space-y-4 p-5">
          <div>
            <p className="text-sm font-bold">Add a notification channel</p>
            <p className="text-muted-foreground text-xs">
              Where should swarmy reach you when an alert fires? Encrypted, never shown again.
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ch-name">Name</Label>
              <Input
                id="ch-name"
                placeholder="On-call email"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Kind</Label>
              <ChannelKindPicker value={kind} onChange={setKind} />
            </div>
          </div>
          <ChannelDestinationFields
            kind={kind}
            to={to}
            onToChange={setTo}
            url={url}
            onUrlChange={setUrl}
            secret={secret}
            onSecretChange={setSecret}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={!ready || create.isPending}
              onClick={() => config && create.mutate({ name: name.trim(), config })}
            >
              {create.isPending ? 'Adding…' : 'Add channel'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
