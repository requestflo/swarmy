import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NotificationChannelKindView } from '@swarmy/core';
import { Button, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ChannelDestinationFields, EMPTY_CHANNEL_FIELDS, channelConfigFrom, type ChannelFields } from './channel-destination-fields';
import { ChannelKindPicker, KIND_LABEL } from './channel-kind-picker';

/** Add a channel: pick the kind (every kind createChannel accepts), name it, say where. Nothing is sent until you save. */
export function AddChannelCard({ onClose }: { onClose: () => void }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<NotificationChannelKindView>('slack');
  const [fields, setFields] = React.useState<ChannelFields>(EMPTY_CHANNEL_FIELDS);
  const create = useMutation(
    trpc.alerts.createChannel.mutationOptions({
      onSuccess: (c) => {
        toast.success(`${c.name} added. Send it a test.`);
        void qc.invalidateQueries({ queryKey: trpc.alerts.pathKey() });
        onClose();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const config = channelConfigFrom(kind, fields);
  const ready = Boolean(name.trim() && config);

  return (
    <div className="calm-card flex flex-col gap-4 px-4 py-4">
      <div>
        <h3 className="font-display text-[15.5px] font-bold">Add a channel</h3>
        <p className="text-muted-foreground text-xs">Where should swarmy reach you? The kind is fixed once it’s made.</p>
      </div>
      <ChannelKindPicker value={kind} onChange={setKind} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ch-name">Name</Label>
        <Input id="ch-name" placeholder={`${KIND_LABEL[kind]} #ops`} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <ChannelDestinationFields kind={kind} fields={fields} onChange={setFields} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" className="pointer-coarse:min-h-11" disabled={!ready || create.isPending} onClick={() => config && create.mutate({ name: name.trim(), config })}>
          {create.isPending ? 'Saving…' : `Save ${KIND_LABEL[kind]}`}
        </Button>
        <Button variant="ghost" className="pointer-coarse:min-h-11" onClick={onClose}>
          Cancel
        </Button>
        <span className="text-muted-foreground ml-auto text-xs">nothing is sent until you save</span>
      </div>
    </div>
  );
}
