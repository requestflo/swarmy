import * as React from 'react';
import { Label, Switch } from '@swarmy/ui';
import { ssoInviteLine } from './sso-only-words';
import { useSsoOnly } from './use-sso-only';

/**
 * The invite option "Must accept with SSO" (board 56): the invitee joins only
 * by signing in through this workspace's own SSO, as the invited address (or,
 * for a link, at the provider's domain). Forced on while members sign in with
 * SSO only; unavailable until a provider can sign people in.
 */
export function useSsoInviteOption(chosen: boolean): { requireSso: boolean; forced: boolean; available: boolean } {
  const state = useSsoOnly();
  const forced = state?.on === true;
  const available = (state?.ready.length ?? 0) > 0;
  return { requireSso: forced || (available && chosen), forced, available };
}

export function SsoAcceptChoice({
  value,
  onChange,
  email,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  /** The invite names an address (else: a link). */
  email: boolean;
}): React.JSX.Element {
  const state = useSsoOnly();
  const { requireSso, forced, available } = useSsoInviteOption(value);
  const id = React.useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid gap-0.5">
        <Label htmlFor={id} className="text-[12.5px] font-semibold">
          Must accept with SSO
        </Label>
        <p className="text-muted-foreground text-xs">{ssoInviteLine({ forced, ready: state?.ready ?? [], email })}</p>
      </div>
      <Switch id={id} checked={requireSso} disabled={forced || !available} onCheckedChange={onChange} />
    </div>
  );
}
