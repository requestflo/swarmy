import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { clearInviteCookie } from './invite-cookie';

/**
 * Back from an SSO/social round-trip on `/login?invite=…` with a session: the
 * sign-in hook normally redeemed the invite already; accept (idempotent) to
 * activate its org, then land. A refusal (the invite names another email) is
 * returned so the page can explain it instead of dropping them in limbo.
 */
export function useInviteReturn(
  inviteId: string | undefined,
  signedIn: boolean,
  land: () => Promise<void>,
): string | null {
  const trpc = useTRPC();
  const accept = useMutation(trpc.authConfig.acceptInvite.mutationOptions());
  const [error, setError] = React.useState<string | null>(null);
  const tried = React.useRef(false);
  React.useEffect(() => {
    if (!inviteId || !signedIn || tried.current) return;
    tried.current = true;
    accept
      .mutateAsync({ id: inviteId })
      .then(async () => {
        clearInviteCookie();
        await land();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'could not accept the invite'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteId, signedIn]);
  return error;
}
