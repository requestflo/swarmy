import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCwIcon } from 'lucide-react';
import { Badge, Button, Card, CopyButton, StatusBadge, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { absTime, relTime } from '@/lib/format';

/** Open invite links for this org: copy, regenerate (fresh id + expiry), revoke. */
export function PendingInvitations(): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const invitations = useQuery({ ...trpc.members.listInvitations.queryOptions(), refetchInterval: 15_000 });

  const revoke = useMutation(
    trpc.members.revokeInvitation.mutationOptions({
      onSuccess: () => {
        toast.success('Invite revoked — the link no longer works');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const regenerate = useMutation(
    trpc.members.regenerateInvitation.mutationOptions({
      onSuccess: async (res) => {
        try {
          await navigator.clipboard.writeText(res.link);
          toast.success(`Fresh link for ${res.email} copied — expires ${absTime(res.expiresAt)}`);
        } catch {
          toast.success(`Fresh link ready for ${res.email} — copy it from the list`);
        }
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = invitations.data ?? [];
  if (rows.length === 0) return null;
  const busy = revoke.isPending || regenerate.isPending;

  return (
    <section className="grid gap-3">
      <div className="flex items-baseline justify-between gap-4 px-1">
        <h2 className="font-display text-lg font-semibold">Pending invitations</h2>
        <p className="text-muted-foreground text-xs">Links work once. Nobody gets an email — you send it.</p>
      </div>
      <Card className="card-pop border-0 p-0">
        <div className="divide-border divide-y">
          {rows.map((inv) => {
            const expired = inv.status === 'expired';
            return (
              <div
                key={inv.id}
                className="hover:bg-accent/50 flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 transition-colors"
              >
                <div className="min-w-[12rem] flex-1">
                  <p className="truncate font-medium">{inv.email}</p>
                  <p className="text-muted-foreground text-xs">
                    Invited {relTime(inv.createdAt)}
                    {inv.invitedBy?.name ? ` by ${inv.invitedBy.name}` : ''} ·{' '}
                    {expired ? `expired ${absTime(inv.expiresAt)}` : `expires ${absTime(inv.expiresAt)}`}
                  </p>
                </div>
                <Badge variant="muted">{inv.role}</Badge>
                <StatusBadge tone={expired ? 'warning' : 'progress'} label={expired ? 'expired' : 'pending'} />
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {!expired && <CopyButton value={inv.link} label="Copy link" />}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => regenerate.mutate({ id: inv.id })}
                    title="New id, fresh expiry; the old link stops working"
                  >
                    <RefreshCwIcon className="size-4" /> {expired ? 'New link' : 'Regenerate'}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => revoke.mutate({ id: inv.id })}>
                    Revoke
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </section>
  );
}
