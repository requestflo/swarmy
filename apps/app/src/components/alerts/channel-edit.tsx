import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NotificationChannelView } from '@swarmy/core';
import { Button, Input, Label, toast } from '@swarmy/ui';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { useTRPC } from '@/integrations/trpc';
import { ChannelDestinationFields, EMPTY_CHANNEL_FIELDS, channelConfigFrom, type ChannelFields } from './channel-destination-fields';

/**
 * Edit one channel in place: rename, turn off, point it somewhere new (the
 * kind is fixed once created; a blank destination keeps the stored one) or
 * remove it behind an in-page confirm.
 */
export function ChannelEdit({ channel, onDone }: { channel: NotificationChannelView; onDone: () => void }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = React.useState(channel.name);
  const [enabled, setEnabled] = React.useState(channel.enabled);
  const [fields, setFields] = React.useState<ChannelFields>(EMPTY_CHANNEL_FIELDS);
  const [confirm, setConfirm] = React.useState(false);
  const refresh = (): void => void qc.invalidateQueries({ queryKey: trpc.alerts.pathKey() });
  const update = useMutation(
    trpc.alerts.updateChannel.mutationOptions({
      onSuccess: (c) => {
        toast.success(`${c.name} saved.`);
        refresh();
        onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const remove = useMutation(
    trpc.alerts.deleteChannel.mutationOptions({
      onSuccess: () => {
        toast.success(`${channel.name} removed.`);
        refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const config = channelConfigFrom(channel.kind, fields);
  const changed = name.trim() !== channel.name || enabled !== channel.enabled || config !== null;

  return (
    <div className="border-border flex flex-col gap-3 border-t pt-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor={`ch-name-${channel.id}`}>Name</Label>
          <Input id={`ch-name-${channel.id}`} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <QuietSwitch checked={enabled} onCheckedChange={setEnabled} aria-label={`${channel.name} on`} />
          {enabled ? 'On' : 'Off'}
        </label>
      </div>
      <p className="text-muted-foreground text-xs">Point it somewhere new. Leave these blank to keep where it goes now; it’s never shown again.</p>
      <ChannelDestinationFields kind={channel.kind} fields={fields} onChange={setFields} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="pointer-coarse:min-h-11"
          disabled={!changed || !name.trim() || update.isPending}
          onClick={() => update.mutate({ id: channel.id, name: name.trim(), enabled, ...(config ? { config } : {}) })}
        >
          {update.isPending ? 'Saving…' : 'Save channel'}
        </Button>
        {confirm ? (
          <>
            <span className="text-sm">Remove {channel.name}? Rules that name only this one will reach no one until you pick another.</span>
            <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
            <Button variant="destructive" size="sm" className="pointer-coarse:min-h-11" disabled={remove.isPending} onClick={() => remove.mutate({ id: channel.id })}>
              Remove
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" className="text-muted-foreground ml-auto pointer-coarse:min-h-11" onClick={() => setConfirm(true)}>
            Remove channel
          </Button>
        )}
      </div>
    </div>
  );
}
