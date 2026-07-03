import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MailIcon, MessageSquareIcon, PlusIcon, SendIcon, Trash2Icon, WebhookIcon } from 'lucide-react';
import type { NotificationChannelKindView, NotificationChannelView } from '@swarmy/core';
import { Button, EmptyState, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { AddChannelCard } from './add-channel-card';

const KIND_ICON: Record<NotificationChannelKindView, React.JSX.Element> = {
  email: <MailIcon className="size-4" />,
  slack: <MessageSquareIcon className="size-4" />,
  teams: <MessageSquareIcon className="size-4" />,
  webhook: <WebhookIcon className="size-4" />,
};

function ChannelRow({ channel }: { channel: NotificationChannelView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const invalidate = (): void => void qc.invalidateQueries();
  const test = useMutation(
    trpc.alerts.testChannel.mutationOptions({
      onSuccess: (r) => (r.ok ? toast.success(`Test sent: ${r.detail}`) : toast.error(`Test failed: ${r.detail}`)),
      onError: (e) => toast.error(e.message),
    }),
  );
  const update = useMutation(
    trpc.alerts.updateChannel.mutationOptions({ onSuccess: invalidate, onError: (e) => toast.error(e.message) }),
  );
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
    <div className="flex items-center gap-3 px-5 py-3">
      <span className="text-muted-foreground shrink-0">{KIND_ICON[channel.kind]}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{channel.name}</span>
        <span className="mono-data text-muted-foreground block truncate text-xs">
          {channel.kind} · {channel.target}
          {channel.hasSecret ? ' · signed' : ''}
        </span>
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Test ${channel.name}`}
        disabled={test.isPending}
        onClick={() => test.mutate({ id: channel.id })}
      >
        <SendIcon className="size-4" />
      </Button>
      <Switch
        checked={channel.enabled}
        disabled={update.isPending}
        onCheckedChange={(enabled) => update.mutate({ id: channel.id, enabled })}
        aria-label={`Toggle ${channel.name}`}
      />
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Delete ${channel.name}`}
        disabled={remove.isPending}
        onClick={() => remove.mutate({ id: channel.id })}
      >
        <Trash2Icon className="text-destructive size-4" />
      </Button>
    </div>
  );
}

/** Channels panel: where alerts go — add (inline card), test, toggle, remove. */
export function ChannelsPanel(): React.JSX.Element {
  const trpc = useTRPC();
  const [createOpen, setCreateOpen] = React.useState(false);
  const channels = useQuery({ ...trpc.alerts.channels.queryOptions(), refetchInterval: 30_000 });
  const rows = channels.data ?? [];

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="headline text-xl">Channels</h2>
        <Button onClick={() => setCreateOpen((o) => !o)}>
          <PlusIcon className="size-4" /> Add channel
        </Button>
      </div>

      <AddChannelCard open={createOpen} onOpenChange={setCreateOpen} />

      {channels.isLoading ? (
        <div className="card-pop space-y-3 p-5">
          {[0, 1].map((i) => (
            <div key={i} className="shimmer-line h-9 rounded-lg" />
          ))}
        </div>
      ) : channels.isError ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<SendIcon />}
            title="Couldn't load channels"
            description={channels.error.message}
            action={
              <Button variant="outline" onClick={() => void channels.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="card-pop p-2">
          <EmptyState
            icon={<SendIcon />}
            title="No channels yet — add one."
            description="Alerts only help if they reach you. Add an email, Slack, Teams or webhook channel and send it a test."
            action={
              <Button variant="outline" onClick={() => setCreateOpen(true)}>
                <PlusIcon className="size-4" /> Add channel
              </Button>
            }
          />
        </div>
      ) : (
        <div className="card-pop divide-border divide-y overflow-hidden">
          {rows.map((c) => (
            <ChannelRow key={c.id} channel={c} />
          ))}
        </div>
      )}
    </section>
  );
}
