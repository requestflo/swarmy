import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { UsersIcon } from 'lucide-react';
import { Badge, Card, EmptyState } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';
import { InviteMemberDialog } from './invite-member-dialog';
import { PendingInvitations } from './pending-invitations';

/** Org members as flat rows in one card, plus invite links (admins only). */
export function MembersTab(): React.JSX.Element {
  const trpc = useTRPC();
  const members = useQuery(trpc.org.members.queryOptions());
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  const rows = members.data ?? [];
  const role = org.data?.role;
  const canInvite = role === 'owner' || role === 'admin';

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold">
            {rows.length <= 1 ? 'Just you so far.' : `${rows.length} people run this swarm.`}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {canInvite
              ? 'Invite someone and hand them the link — this controller sends no email.'
              : 'An owner or admin can invite more people.'}
          </p>
        </div>
        {canInvite && <InviteMemberDialog callerRole={role} />}
      </div>

      {canInvite && <PendingInvitations />}

      {rows.length === 0 ? (
        <Card className="card-pop border-0">
          <EmptyState
            className="border-0 py-14"
            icon={<UsersIcon />}
            title="Just you so far"
            description="Invite the rest of the crew — mint a link above and send it to them."
          />
        </Card>
      ) : (
        <Card className="card-pop border-0 p-0">
          <div className="divide-border divide-y">
            {rows.map((m) => (
              <div
                key={m.id}
                className="hover:bg-accent/50 flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-4 transition-colors"
              >
                <div className="min-w-[12rem] flex-1">
                  <p className="truncate font-medium">{m.user.name}</p>
                  <p className="text-muted-foreground truncate text-sm">{m.user.email ?? (m.user.username ? `@${m.user.username}` : 'no email')}</p>
                </div>
                <Badge variant="muted">{m.role}</Badge>
                <p className="mono-data text-muted-foreground ml-auto text-xs">{relTime(m.joinedAt)}</p>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
