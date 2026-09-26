import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Depth, RowList, Section, type Tone } from '@/components/calm';
import { LineRow } from '@/components/rowpage/line-row';
import { SayParts } from '@/components/apikeys/say-parts';
import { CardSkeleton } from '@/components/states';
import { relTime } from '@/lib/format';
import { INVITE_STATE_WORD, inviteEndsWords, usesWords, type InviteState } from './invite-words';
import { NewInviteLinkForm } from './new-invite-link-form';

const TONE: Record<InviteState, Tone> = { ok: 'ok', expired: 'idle', used: 'idle', revoked: 'idle' };

/** Shareable invite links (admins only): mint one, see who it lets in, revoke it. */
export function InviteLinksSection(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const links = useQuery(trpc.inviteLinks.list.queryOptions());
  const revoke = useMutation(
    trpc.inviteLinks.revoke.mutationOptions({
      onSuccess: () => {
        toast.success('Link revoked. People who already joined keep their access.');
        void qc.invalidateQueries({ queryKey: trpc.inviteLinks.list.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const rows = links.data ?? [];
  const live = rows.filter((l) => l.state === 'ok').length;
  return (
    <Section id="invite-links" title="Invite links" count={links.data ? `${live} active` : undefined} hint="no email needed">
      <NewInviteLinkForm />
      {links.isLoading ? (
        <CardSkeleton lines={2} />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground mt-4 text-sm">No links yet. Make one above and paste it in chat: whoever opens it signs in and joins.</p>
      ) : (
        <div className="mt-4 border-t pt-1">
        <RowList label="Invite links">
          {rows.map((l) => (
            <LineRow
              key={l.id}
              tone={TONE[l.state]}
              name={l.role === 'admin' ? 'Admin' : 'Member'}
              sub={l.hint}
              say={<SayParts parts={[l.role === 'admin' ? 'every app' : (l.stackName ?? 'all apps'), usesWords(l.uses, l.maxUses), inviteEndsWords(l.state, l.expiresAt)]} />}
              tech={`${l.prefix} · made ${relTime(l.createdAt)}${l.createdBy?.name ? ` by ${l.createdBy.name}` : ''} · no copy: only a hash of the token is kept`}
              word={INVITE_STATE_WORD[l.state]}
              trailing={
                l.state === 'ok' ? (
                  <Depth at="controls">
                    <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" disabled={revoke.isPending} onClick={() => revoke.mutate({ id: l.id })}>
                      Revoke
                    </Button>
                  </Depth>
                ) : null
              }
            />
          ))}
        </RowList>
        </div>
      )}
    </Section>
  );
}
