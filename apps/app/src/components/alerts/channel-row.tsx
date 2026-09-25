import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SendIcon, Trash2Icon } from 'lucide-react';
import type { NotificationChannelView } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { useTRPC } from '@/integrations/trpc';
import { CalmRow, Depth } from '@/components/calm';

/** One place alerts go: name and where, and from Controls test / on-off / remove. */
export function ChannelRow({ channel }: { channel: NotificationChannelView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const invalidate = (): void => void qc.invalidateQueries();
  const test = useMutation(
    trpc.alerts.testChannel.mutationOptions({
      onSuccess: (r) => (r.ok ? toast.success(`Test sent: ${r.detail}`) : toast.error(`Test failed: ${r.detail}`)),
      onError: (e) => toast.error(e.message),
    }),
  );
  const update = useMutation(trpc.alerts.updateChannel.mutationOptions({ onSuccess: invalidate, onError: (e) => toast.error(e.message) }));
  const remove = useMutation(
    trpc.alerts.deleteChannel.mutationOptions({
      onSuccess: () => {
        toast.success(`Channel ${channel.name} removed.`);
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <CalmRow
      tone={channel.enabled ? 'ok' : 'idle'}
      name={channel.name}
      sub={`${channel.kind} · ${channel.target}`}
      tech={channel.hasSecret ? 'signed (HMAC)' : 'encrypted at rest'}
      word={channel.enabled ? 'On' : 'Off'}
      trailing={
        <Depth at="controls">
          <Button variant="ghost" size="icon" aria-label={`Send a test to ${channel.name}`} disabled={test.isPending} onClick={() => test.mutate({ id: channel.id })} className="pointer-coarse:size-11">
            <SendIcon className="size-4" />
          </Button>
          <QuietSwitch checked={channel.enabled} disabled={update.isPending} onCheckedChange={(enabled) => update.mutate({ id: channel.id, enabled })} aria-label={`Turn ${channel.name} ${channel.enabled ? 'off' : 'on'}`} />
          <Button variant="ghost" size="icon" aria-label={`Remove ${channel.name}`} disabled={remove.isPending} onClick={() => remove.mutate({ id: channel.id })} className="pointer-coarse:size-11">
            <Trash2Icon className="text-tone-bad size-4" />
          </Button>
        </Depth>
      }
    />
  );
}
