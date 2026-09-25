import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useSession } from '@swarmy/auth/client';
import { SignInLayout } from '@/components/auth/sign-in-layout';
import { DemoAuthPage } from '@/demo/demo-unavailable';
import { DEMO_BUILD } from '@/demo/site';

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
  // The hosted demo has no accounts: a notice replaces the sign-in screen.
  component: DEMO_BUILD ? DemoAuthPage : AppLoginPage,
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
    <SignInLayout
      title={host ? <>Continuing to <em>{host}</em></> : 'That sign-in link is incomplete.'}
      lede={host ? 'One moment. swarmy is checking who you are.' : 'Open the app again to start over.'}
    >
      {host ? <span className="pulse-dot" aria-hidden /> : null}
    </SignInLayout>
  );
}
