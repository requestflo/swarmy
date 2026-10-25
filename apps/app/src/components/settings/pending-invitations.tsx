import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCwIcon } from 'lucide-react';
import { Button, CopyButton, toast } from '@swarmy/ui';
import { Depth, Section, StatusWord } from '@/components/calm';
import { SayParts } from '@/components/apikeys/say-parts';
import { useTRPC } from '@/integrations/trpc';
import { useSsoOnly } from '@/components/access/use-sso-only';
import { absTime, relTime } from '@/lib/format';

async function copied(link: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(link);
    return true;
  } catch {
    return false;
  }
}

/** Invited, not joined yet: resend, revoke, copy the link (every one works once and lasts 7 days). */
export function PendingInvitations(): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const invitations = useQuery({ ...trpc.members.listInvitations.queryOptions(), refetchInterval: 15_000 });
  const ssoOn = useSsoOnly()?.on === true;
  const refresh = (): void => void qc.invalidateQueries({ queryKey: trpc.members.listInvitations.queryKey() });
  const revoke = useMutation(
    trpc.members.revokeInvitation.mutationOptions({
      onSuccess: () => (toast.success('Invite revoked. The link no longer works.'), refresh()),
      onError: (e) => toast.error(e.message),
    }),
  );
  const resend = useMutation(
    trpc.members.resendInvitation.mutationOptions({
      onSuccess: async (res) => {
        refresh();
        if (res.emailed) return void toast.success(`Sent to ${res.email} again`);
        const ok = await copied(res.link);
        toast.info(`Email isn’t set up here, so nothing was sent. ${ok ? 'The link is copied' : 'Copy the link'} for ${res.email}.`);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const regenerate = useMutation(
    trpc.members.regenerateInvitation.mutationOptions({
      onSuccess: async (res) => {
        refresh();
        toast.success(`Fresh link ${(await copied(res.link)) ? 'copied' : 'ready'}, expires ${absTime(res.expiresAt)}`);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows = invitations.data ?? [];
  if (rows.length === 0) return null;
  const busy = revoke.isPending || resend.isPending || regenerate.isPending;

  return (
    <Section id="pending-invites" title="Pending invites" count={rows.length} hint="links expire after 7 days" flush>
      <ul className="flex flex-col">
        {rows.map((inv) => {
          const expired = inv.status === 'expired';
          return (
            <li key={inv.id} className="border-border flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-2.5 last:border-b-0">
              <div className="min-w-[12rem] flex-1">
                <p className="truncate font-mono text-[12.5px]">{inv.email ?? 'Invite link (no email)'}</p>
                <p className="text-muted-foreground text-xs">
                  <SayParts parts={[inv.stackName ? `on ${inv.stackName}` : null, inv.requireSso || ssoOn ? 'accept with SSO' : null, `sent ${relTime(inv.createdAt)}`, inv.invitedBy?.name ? `by ${inv.invitedBy.name}` : null, expired ? 'expired' : `expires ${absTime(inv.expiresAt)}`]} />
                </p>
              </div>
              <StatusWord tone={expired ? 'warn' : 'info'} word={inv.role} />
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {!expired ? <CopyButton value={inv.link} label="Copy link" /> : null}
                {inv.kind === 'email' ? (
                  <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" disabled={busy} onClick={() => resend.mutate({ id: inv.id })}>
                    Resend
                  </Button>
                ) : null}
                <Depth at={inv.kind === 'email' || !expired ? 'controls' : 'summary'}>
                  <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" disabled={busy} onClick={() => regenerate.mutate({ id: inv.id })} title="New link, fresh 7 days; the old link stops working">
                    <RefreshCwIcon className="size-4" /> New link
                  </Button>
                </Depth>
                <Button variant="ghost" size="sm" className="text-tone-bad pointer-coarse:min-h-11" disabled={busy} onClick={() => revoke.mutate({ id: inv.id })}>
                  Revoke
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
