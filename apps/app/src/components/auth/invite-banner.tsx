import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { MailOpenIcon } from 'lucide-react';
import { useTRPC } from '@/integrations/trpc';

/** Who an invite link is from. The link itself is the credential; no email needed. */
export function InviteBanner({ inviteId, demo }: { inviteId: string; demo?: boolean }): React.JSX.Element | null {
  const trpc = useTRPC();
  const preview = useQuery(trpc.authConfig.invitePreview.queryOptions({ id: inviteId }));
  if (preview.isPending) return null;
  const p = preview.data;
  return (
    <div className="bg-muted mb-5 flex items-start gap-3 rounded-lg p-3 text-sm">
      <MailOpenIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      {!p ? (
        <span>This invite link has been used, revoked, or never existed. Ask for a new one.</span>
      ) : p.expired ? (
        <span>
          {p.state === 'used'
            ? `This invite link to ${p.orgName} has been used up. Ask an admin for a fresh one.`
            : `This invite to ${p.orgName} has expired. Ask an admin for a fresh link.`}
        </span>
      ) : (
        <span>
          You&rsquo;re invited to join <strong>{p.orgName}</strong> as {p.role === 'admin' ? 'an admin' : `a ${p.role}`}
          {p.stackName ? (
            <>
              {' '}on <strong>{p.stackName}</strong>
            </>
          ) : null}
          . {demo ? 'In the demo you are already in, so there is nothing to accept.' : 'Continue with your usual sign-in, or create a username below.'}
        </span>
      )}
    </div>
  );
}
