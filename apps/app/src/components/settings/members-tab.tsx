import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { UsersIcon } from 'lucide-react';
import { Badge, Card, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';

/** Org members as flat rows in one card, divided by hairlines. */
export function MembersTab(): React.JSX.Element {
  const trpc = useTRPC();
  const members = useQuery(trpc.org.members.queryOptions());
  const rows = members.data ?? [];

  if (rows.length === 0) {
    return (
      <Card className="card-pop border-0">
        <EmptyState
          className="border-0 py-14"
          icon={<UsersIcon />}
          title="Just you so far"
          description="Invite the rest of the crew to share the swarm."
        />
      </Card>
    );
  }

  return (
    <Card className="card-pop border-0 p-0">
      <div className="divide-border divide-y">
        {rows.map((m) => (
          <div
            key={m.id}
            className="hover:bg-accent/50 flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-4 transition-colors"
          >
            <div className="min-w-[12rem] flex-1">
              <p className="truncate font-medium">{m.user.name}</p>
              <p className="text-muted-foreground truncate text-sm">{m.user.email}</p>
            </div>
            <Badge variant="muted">{m.role}</Badge>
            <p className="mono-data text-muted-foreground ml-auto text-xs">{relTime(m.joinedAt)}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}
