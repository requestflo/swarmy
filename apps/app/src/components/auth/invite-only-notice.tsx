import * as React from 'react';
import { MailIcon } from 'lucide-react';

/** Shown instead of the sign-up form on an invite-only controller. */
export function InviteOnlyNotice(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <MailIcon className="text-muted-foreground size-6" />
      <p className="font-medium">Registration is invite-only on this swarmy.</p>
      <p className="text-muted-foreground text-sm">
        Ask an admin to invite you, then open the invite link to create your account.
      </p>
    </div>
  );
}
