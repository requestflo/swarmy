import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { InboxIcon } from 'lucide-react';
import { Input, StatusBadge, type StatusTone } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton, EmptyState } from '@/components/states';

const EVENTS = ['queued', 'accepted', 'delivered', 'deferred', 'rejected', 'failed', 'bounced', 'complained'] as const;
type EventKind = (typeof EVENTS)[number];
const TONE: Record<EventKind, StatusTone> = {
  queued: 'progress',
  accepted: 'progress',
  delivered: 'online',
  deferred: 'warning',
  rejected: 'offline',
  failed: 'offline',
  bounced: 'offline',
  complained: 'offline',
};

/** The send log: one row per recipient event, newest first. Metadata only. */
export function SendLogTab({ logStore }: { logStore: 'clickhouse' | 'memory' }): React.JSX.Element {
  const trpc = useTRPC();
  const [search, setSearch] = React.useState('');
  const [event, setEvent] = React.useState<EventKind | ''>('');
  const log = useQuery({
    ...trpc.email.log.queryOptions({ search: search || undefined, event: event || undefined, limit: 200 }),
    refetchInterval: 5_000,
  });
  return (
    <div className="card-pop p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Search recipient, sender, subject, id" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="border-input bg-background h-9 rounded-md border px-2 text-sm" value={event} onChange={(e) => setEvent(e.target.value as EventKind | '')}>
          <option value="">All events</option>
          {EVENTS.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
        <span className="text-muted-foreground ml-auto text-xs">
          {logStore === 'clickhouse' ? 'Stored in ClickHouse' : 'Recent events in memory only'}
        </span>
      </div>
      {log.isPending ? (
        <div className="mt-4">
          <CardSkeleton />
        </div>
      ) : !log.data || log.data.items.length === 0 ? (
        <EmptyState icon={<InboxIcon />} title="Nothing sent yet — try a test send." description="Every message an app sends shows up here: queued, delivered, deferred, bounced." />
      ) : (
        <div className="border-border divide-border mt-4 divide-y rounded-xl border">
          {log.data.items.map((e, i) => (
            <div key={`${e.ts}-${e.rcpt}-${e.event}-${i}`} className="grid gap-1 px-4 py-2 text-sm md:grid-cols-[10rem_7rem_1fr_1fr]">
              <span className="mono-data text-muted-foreground text-xs">{new Date(e.ts).toLocaleString()}</span>
              <StatusBadge tone={TONE[e.event as EventKind] ?? 'neutral'} label={e.event} />
              <span className="min-w-0 truncate">
                <span className="mono-data text-xs">{e.rcpt || '—'}</span>
                {e.subject ? <span className="text-muted-foreground ml-2 text-xs">“{e.subject}”</span> : null}
              </span>
              <span className="text-muted-foreground min-w-0 truncate text-xs">
                {e.sender} {e.credential ? `· ${e.credential}` : ''} {e.detail ? `· ${e.smtpCode ? `${e.smtpCode} ` : ''}${e.detail}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
