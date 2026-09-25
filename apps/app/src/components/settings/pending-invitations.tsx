import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCwIcon } from 'lucide-react';
import { Button, CopyButton, toast } from '@swarmy/ui';
import { Depth, StatusWord } from '@/components/calm';
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
          toast.success(`Fresh link${res.email ? ` for ${res.email}` : ''} copied — expires ${absTime(res.expiresAt)}`);
        } catch {
          toast.success(`Fresh link${res.email ? ` for ${res.email}` : ''} ready — copy it from the list`);
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
    <div className="flex flex-col pt-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-1">
        <h3 className="calm-eyebrow">Invited, not joined yet</h3>
        <p className="text-muted-foreground text-xs">Links work once. Nobody gets an email; you send it.</p>
      </div>
        <div className="flex flex-col">
          {rows.map((inv) => {
            const expired = inv.status === 'expired';
            return (
              <div
                key={inv.id}
                className="border-border flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-1 py-2.5 last:border-b-0"
              >
                <div className="min-w-[12rem] flex-1">
                  <p className="truncate font-medium">{inv.email ?? 'Invite link (no email)'}</p>
                  <p className="text-muted-foreground text-xs">
                    Invited {relTime(inv.createdAt)}
                    {inv.invitedBy?.name ? ` by ${inv.invitedBy.name}` : ''} ·{' '}
                    {expired ? `expired ${absTime(inv.expiresAt)}` : `expires ${absTime(inv.expiresAt)}`}
                  </p>
                </div>
                <StatusWord tone={expired ? 'warn' : 'info'} word={expired ? `${inv.role} · expired` : `${inv.role} · waiting`} />
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {!expired && <CopyButton value={inv.link} label="Copy link" />}
                  <Depth at="controls">
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
                  </Depth>
                </div>
              </div>
            );
          })}
        </div>
    </div>
  );
}
