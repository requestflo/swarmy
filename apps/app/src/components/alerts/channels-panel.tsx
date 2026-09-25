import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { RowList, Section } from '@/components/calm';
import { CardSkeleton, ErrorState } from '@/components/states';
import { AddChannelCard } from './add-channel-card';
import { ChannelRow } from './channel-row';

/** Where alerts go: each channel, plus the inline add card. */
export function ChannelsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }): React.JSX.Element {
  const trpc = useTRPC();
  const channels = useQuery({ ...trpc.alerts.channels.queryOptions(), refetchInterval: 30_000 });
  if (channels.isLoading) return <CardSkeleton />;
  if (channels.isError) return <ErrorState title="Couldn’t load the channels." error={channels.error} retry={() => void channels.refetch()} />;
  const rows = channels.data ?? [];
  return (
    <Section
      title="Where alerts go"
      count={rows.length || undefined}
      hint="encrypted, never shown again"
      flush
      action={
        <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" aria-expanded={open} onClick={() => onOpenChange(!open)}>
          <PlusIcon className="size-4" /> Add
        </Button>
      }
    >
      <AddChannelCard open={open} onOpenChange={onOpenChange} />
      <RowList label="Notification channels">
        {rows.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">Nowhere yet. Alerts only help if they reach someone: add an email, Slack or a webhook.</p>
        ) : (
          rows.map((c) => <ChannelRow key={c.id} channel={c} />)
        )}
      </RowList>
    </Section>
  );
}
