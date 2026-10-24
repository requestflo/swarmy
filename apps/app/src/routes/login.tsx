import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { toast } from '@swarmy/ui';
import { AuthForm } from '@/components/auth/auth-form';
import { InviteBanner } from '@/components/auth/invite-banner';
import { setInviteCookie } from '@/components/auth/invite-cookie';
import { InviteOnlyNotice } from '@/components/auth/invite-only-notice';
import { validateLoginSearch } from '@/components/auth/login-search';
import { OrDivider, SignInOptions } from '@/components/auth/sign-in-options';
import { useInviteReturn } from '@/components/auth/use-invite-return';
import { useSsoAutostart } from '@/components/auth/use-sso-autostart';
import { isOAuthAuthorizeFlow, resumeAuthorize, useOAuthResume } from '@/components/auth/use-oauth-resume';
import { LoginTwoFactorStep } from '@/components/auth/login-two-factor-step';
import { type AuthFields, type AuthMode, useAuthSubmit } from '@/components/auth/use-auth-submit';
import { SignInLayout } from '@/components/auth/sign-in-layout';
import { DemoAuthPage } from '@/demo/demo-unavailable';
import { DEMO_BUILD } from '@/demo/site';
import { useSession } from '@swarmy/auth/client';
import { useTRPC } from '@/integrations/trpc';

export const Route = createFileRoute('/login')({
  validateSearch: validateLoginSearch,
  // The hosted demo has no accounts: a notice replaces the sign-in screen.
  component: DEMO_BUILD ? DemoLoginPage : LoginPage,
});

/** The demo has no accounts; an invite link (/join/swi_…) still previews who it's from. */
function DemoLoginPage(): React.JSX.Element {
  const { invite } = Route.useSearch();
  return <DemoAuthPage notice={invite ? <InviteBanner inviteId={invite} demo /> : undefined} />;
}

function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const router = useRouter();
  const trpc = useTRPC();
  const { redirect: returnTo, invite, sso } = Route.useSearch();
  const [mode, setMode] = React.useState<AuthMode>(invite ? 'signup' : 'signin');
  const { busy, submit, finish } = useAuthSubmit(invite);
  // Password accepted, 2FA pending: the code step replaces the form.
  const [challenge, setChallenge] = React.useState(false);
  const config = useQuery(trpc.authConfig.publicConfig.queryOptions());
  // Until the mode is known, assume invite-only so the sign-up link never flashes.
  const signupOpen = invite !== undefined || config.data?.signupMode === 'open';
  const session = useSession();
  useOAuthResume(Boolean(session.data));
  // Park the invite so an SSO/social round-trip (which leaves the page) still redeems it.
  React.useEffect(() => {
    if (invite) setInviteCookie(invite);
  }, [invite]);
  // SSO/social come back to the page they started from (with an invite, to
  // this page, which confirms it); the server hook redeems it on sign-in.
  const callbackURL =
    returnTo ?? (isOAuthAuthorizeFlow() || invite ? `/login${window.location.search}` : '/');

  async function land(): Promise<void> {
    // /app-login reads useSession on mount; a client-side push can still see the
    // pre-sign-in (null) session and bounce straight back here. A full load
    // starts with the new cookie.
    if (returnTo?.startsWith('/app-login')) window.location.assign(returnTo);
    else if (returnTo) router.history.push(returnTo);
    else await navigate({ to: '/' });
  }
  // The form path accepts the invite itself; this covers SSO/social returns.
  const viaForm = React.useRef(false);
  const inviteError = useInviteReturn(
    invite,
    Boolean(session.data) && !isOAuthAuthorizeFlow() && !busy && !viaForm.current,
    land,
  );
  const ssoError = useSsoAutostart(sso, config.data?.signIn, callbackURL);

  async function onSubmit(fields: AuthFields): Promise<void> {
    viaForm.current = true;
    try {
      const result = await submit(mode, fields);
      if (result === 'redirect') return;
      if (result === 'two-factor') {
        setChallenge(true);
        return;
      }
    } catch (err) {
      // An invitee who already has an account lands on sign-up by default: send
      // them to sign-in, which accepts the same invitation after auth.
      if (mode === 'signup' && invite && /already exist/i.test(err instanceof Error ? err.message : '')) {
        setMode('signin');
        toast.info('You already have an account — sign in to accept the invite.');
        return;
      }
      throw err;
    }
    await land();
  }

  const options = challenge ? [] : (config.data?.signIn ?? []);
  return (
    <SignInLayout
      title={mode === 'signin' ? 'Sign in to swarmy.' : 'Run your swarm.'}
      lede={
        mode === 'signup'
          ? invite ? 'Create your account to join the team that invited you.' : 'Set up your account and first team. Anyone can just deploy.'
          : options.length ? 'Use the account your team already uses. No new password to remember.' : 'Sign in with your username or email.'
      }
      foot={
        !challenge && (signupOpen || mode === 'signup') ? (
          <p>
            {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
            <button type="button" className="text-foreground font-semibold hover:underline pointer-coarse:min-h-11" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
              {mode === 'signin' ? 'Sign up' : 'Sign in'}
            </button>
          </p>
        ) : mode === 'signin' && !challenge ? (
          <p>New here? Ask an admin on your team for an invite link.</p>
        ) : null
      }
    >
      {invite && !challenge && <InviteBanner inviteId={invite} />}
      {(inviteError ?? ssoError) && <p className="text-tone-bad mb-4 text-sm font-medium">{inviteError ?? ssoError}</p>}
      {options.length > 0 && (
        <>
          <SignInOptions options={options} callbackURL={callbackURL} />
          <OrDivider />
        </>
      )}
      {challenge ? (
        <LoginTwoFactorStep
          onVerified={async () => {
            if (isOAuthAuthorizeFlow()) return resumeAuthorize();
            await finish('signin');
            await land();
          }}
          onCancel={() => setChallenge(false)}
        />
      ) : mode === 'signup' && !signupOpen ? (
        <InviteOnlyNotice />
      ) : (
        <AuthForm mode={mode} busy={busy} onSubmit={onSubmit} dashboardUrl={config.data?.dashboardUrl} quiet={options.length > 0} />
      )}
    </SignInLayout>
  );
}
