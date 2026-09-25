import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NotificationChannelKindView } from '@swarmy/core';
import { Button, Collapsible, CollapsibleContent, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import {
  ChannelDestinationFields,
  EMPTY_CHANNEL_FIELDS,
  channelConfigFrom,
  type ChannelFields,
} from './channel-destination-fields';
import { ChannelKindPicker } from './channel-kind-picker';

interface AddChannelCardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Inline expanding card: add a notification channel (email, chat apps, push, or a webhook). */
export function AddChannelCard({ open, onOpenChange }: AddChannelCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<NotificationChannelKindView>('email');
  const [fields, setFields] = React.useState<ChannelFields>(EMPTY_CHANNEL_FIELDS);

  const reset = (): void => {
    setName('');
    setKind('email');
    setFields(EMPTY_CHANNEL_FIELDS);
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

  const config = channelConfigFrom(kind, fields);
  const ready = Boolean(name.trim() && config);

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleContent>
        <div className="border-border mb-3 space-y-4 rounded-xl border p-4">
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
          <ChannelDestinationFields kind={kind} fields={fields} onChange={setFields} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="outline"
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
