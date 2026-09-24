import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Card, CardContent, toast } from '@swarmy/ui';
import { AuthForm } from '@/components/auth/auth-form';
import { InviteOnlyNotice } from '@/components/auth/invite-only-notice';
import { LoginTwoFactorStep } from '@/components/auth/login-two-factor-step';
import { type AuthFields, type AuthMode, useAuthSubmit } from '@/components/auth/use-auth-submit';
import { Wordmark } from '@/components/wordmark';
import { useTRPC } from '@/integrations/trpc';

interface LoginSearch {
  /** Where a session loss ejected the user from; same-origin paths only. */
  redirect?: string;
  /** Organization invitation id from an invite link — accepted after auth. */
  invite?: string;
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => {
    const out: LoginSearch = {};
    const r = search.redirect;
    if (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') && !r.includes('\\')) out.redirect = r;
    const i = search.invite;
    if (typeof i === 'string' && /^[\w-]{1,128}$/.test(i)) out.invite = i;
    return out;
  },
  component: LoginPage,
});

function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const router = useRouter();
  const trpc = useTRPC();
  const { redirect: returnTo, invite } = Route.useSearch();
  const [mode, setMode] = React.useState<AuthMode>(invite ? 'signup' : 'signin');
  const { busy, submit, finish } = useAuthSubmit(invite);
  // Password accepted, 2FA pending: the code step replaces the form.
  const [challenge, setChallenge] = React.useState(false);
  const config = useQuery(trpc.authConfig.publicConfig.queryOptions());
  // Until the mode is known, assume invite-only so the sign-up link never flashes.
  const signupOpen = invite !== undefined || config.data?.signupMode === 'open';

  async function land(): Promise<void> {
    if (returnTo) router.history.push(returnTo);
    else await navigate({ to: '/' });
  }

  async function onSubmit(fields: AuthFields): Promise<void> {
    try {
      if ((await submit(mode, fields)) === 'two-factor') {
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

  return (
    <div className="mesh bg-background flex min-h-screen items-center justify-center p-4">
      <div className="mx-auto flex w-full max-w-md flex-col">
        <div className="mb-8 flex flex-col items-center text-center">
          <Wordmark className="text-2xl" />
          <span className="eyebrow mt-6 text-muted-foreground">Welcome</span>
          <h1 className="headline mt-3 text-[2.4rem] sm:text-5xl/[3.4rem]">
            {mode === 'signin' ? <>Welcome <em>back</em>.</> : <>Run your <em>swarm</em>.</>}
          </h1>
          <p className="text-muted-foreground mt-3 text-sm">
            {mode === 'signin'
              ? 'Sign in to your swarmy controller.'
              : invite
                ? 'Create your account to join the team that invited you.'
                : 'Set up your account and first team. Anyone can just deploy.'}
          </p>
        </div>

        <Card className="card-pop border-0">
          <CardContent className="pt-6">
            {challenge ? (
              <LoginTwoFactorStep
                onVerified={async () => {
                  await finish('signin');
                  await land();
                }}
                onCancel={() => setChallenge(false)}
              />
            ) : mode === 'signup' && !signupOpen ? (
              <InviteOnlyNotice />
            ) : (
              <AuthForm mode={mode} busy={busy} onSubmit={onSubmit} />
            )}
            {!challenge && (signupOpen || mode === 'signup') && (
              <p className="text-muted-foreground mt-6 text-center text-sm">
                {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
                <button
                  type="button"
                  className="text-primary font-medium hover:underline"
                  onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
                >
                  {mode === 'signin' ? 'Sign up' : 'Sign in'}
                </button>
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
