import * as React from 'react';
import { LinkIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, CopyButton } from '@swarmy/ui';
import { absTime } from '@/lib/format';

export interface IssuedInvite {
  /** null for a link-only invite. */
  email: string | null;
  role: string;
  link: string;
  expiresAt: string | Date;
}

/**
 * Navy statement panel shown once an invite link exists. There is no mailer on a
 * self-hosted controller, so the admin carries the link to the invitee.
 */
export function InviteLinkPanel({ invite }: { invite: IssuedInvite }): React.JSX.Element {
  return (
    <Alert className="ink-block border-0">
      <LinkIcon className="size-4" />
      <AlertTitle className="font-bold">
        {invite.email ? `Send this link to ${invite.email}.` : 'Send this link to the person you are inviting.'}
      </AlertTitle>
      <AlertDescription className="text-ink-foreground/70">
        <p className="text-xs">
          It works once and expires <span className="mono-data">{absTime(invite.expiresAt)}</span> (links last 7 days). They open it,
          sign in with SSO, a social account or a new username, and land in this org as{' '}
          <span className="font-semibold">{invite.role}</span>.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="bg-ink-foreground/10 mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs">
            {invite.link}
          </code>
          <CopyButton value={invite.link} label="Copy link" />
        </div>
      </AlertDescription>
    </Alert>
  );
}
