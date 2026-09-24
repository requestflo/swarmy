import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldAlertIcon } from 'lucide-react';
import { Button, Card, CardContent } from '@swarmy/ui';
import { authClient } from '@swarmy/auth/client';
import { Wordmark } from '@/components/wordmark';
import { CodeEntryForm } from './code-entry-form';
import { TwoFactorCard } from './two-factor-card';
import { verifySecondFactor } from './two-factor-api';

function WallFrame({ title, body, children }: { title: string; body: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div className="flex flex-col items-center text-center">
          <Wordmark className="text-2xl" />
          <h1 className="mt-6 text-2xl font-semibold">{title}</h1>
          <p className="text-muted-foreground mt-2 text-sm">{body}</p>
        </div>
        {children}
        <Button
          variant="ghost"
          onClick={async () => {
            await authClient.signOut();
            window.location.assign('/login');
          }}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}

/** A magic-link / social session of a 2FA user: owes a code before anything loads. */
export function MfaChallengeScreen(): React.JSX.Element {
  const qc = useQueryClient();
  return (
    <WallFrame title="One more step" body="Enter a code from your authenticator app to finish signing in.">
      <Card className="card-pop border-0">
        <CardContent className="pt-6">
          <CodeEntryForm
            submitLabel="Continue"
            onSubmit={async (code, kind) => {
              await verifySecondFactor(code, kind);
              await qc.invalidateQueries();
            }}
          />
        </CardContent>
      </Card>
    </WallFrame>
  );
}

/** Past the org's grace period: enrolment is the only way forward. */
export function EnrolRequiredScreen(): React.JSX.Element {
  return (
    <WallFrame
      title="Two-factor required"
      body="This workspace requires two-factor authentication and your grace period has ended. Set up an authenticator app to continue."
    >
      <TwoFactorCard />
    </WallFrame>
  );
}

/** Inside the grace period: a dismissible-by-enrolling reminder. */
export function GraceBanner({ deadline }: { deadline: Date | null }): React.JSX.Element {
  return (
    <div className="bg-status-warning/10 text-foreground flex flex-wrap items-center justify-center gap-2 px-4 py-2 text-sm">
      <ShieldAlertIcon className="text-status-warning size-4" />
      Your workspace requires two-factor authentication.
      {deadline ? ` Set it up by ${deadline.toLocaleDateString()}.` : ''}
      <a href="/settings/access" className="font-medium underline">
        Set up now
      </a>
    </div>
  );
}
