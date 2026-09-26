import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * A shareable invite link (`<controller>/join/swi_…`) — public, OUTSIDE the
 * `_authed` layout. It only hands the token to the sign-in page, whose
 * InviteBanner previews it and whose sign-in/sign-up accepts it
 * (authConfig.invitePreview / acceptInvite take `swi_` ids).
 */
export const Route = createFileRoute('/join/$token')({
  beforeLoad: ({ params }) => {
    const ok = /^[\w-]{1,128}$/.test(params.token);
    throw redirect({ to: '/login', search: ok ? { invite: params.token } : {}, replace: true });
  },
});
