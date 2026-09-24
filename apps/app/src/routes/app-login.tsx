import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useSession } from '@swarmy/auth/client';
import { Wordmark } from '@/components/wordmark';

interface AppLoginSearch {
  rd?: string;
}

/**
 * Protect my app — the swarmy side of an app's sign-in. The edge sends
 * visitors of a login-protected app here with `rd` = where they were going.
 * Signed out → the normal login page (SSO, social, magic link), which comes
 * back here; signed in → the controller hands the app a one-time code
 * (`/_app-auth/start`), which becomes a first-party cookie on the app's domain.
 */
export const Route = createFileRoute('/app-login')({
  validateSearch: (search: Record<string, unknown>): AppLoginSearch =>
    typeof search.rd === 'string' && /^https?:\/\//.test(search.rd) ? { rd: search.rd } : {},
  component: AppLoginPage,
});

function hostOf(rd: string | undefined): string | null {
  try {
    return rd ? new URL(rd).host : null;
  } catch {
    return null;
  }
}

function AppLoginPage(): React.JSX.Element {
  const { rd } = Route.useSearch();
  const session = useSession();
  const navigate = useNavigate();
  const host = hostOf(rd);

  React.useEffect(() => {
    if (!rd || session.isPending) return;
    if (session.data) {
      window.location.replace(`/_app-auth/start?rd=${encodeURIComponent(rd)}`);
    } else {
      void navigate({ to: '/login', search: { redirect: `/app-login?rd=${encodeURIComponent(rd)}` } });
    }
  }, [rd, session.isPending, session.data, navigate]);

  return (
    <div className="mesh bg-background flex min-h-screen items-center justify-center p-4">
      <div className="flex flex-col items-center text-center">
        <Wordmark className="text-2xl" />
        <span className="eyebrow mt-6 text-muted-foreground">Sign in</span>
        <h1 className="headline mt-3 text-[2rem] sm:text-4xl">
          {host ? (
            <>
              Continuing to <em>{host}</em>
            </>
          ) : (
            'That sign-in link is incomplete.'
          )}
        </h1>
        <p className="text-muted-foreground mt-3 max-w-sm">
          {host ? 'One moment. swarmy is checking who you are.' : 'Open the app again to start over.'}
        </p>
        {host ? <span className="pulse-dot mt-6" aria-hidden /> : null}
      </div>
    </div>
  );
}
