import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { Section, StatusWord, Tech } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { EnrolTwoFactorDialog } from './enrol-two-factor-dialog';
import { ManageTwoFactorDialog, type ManageAction } from './manage-two-factor-dialog';

/** Your own authenticator-app 2FA: enrol, regenerate backup codes, disable. `primary` makes "Set up" the page's one action. */
export function TwoFactorCard({ primary = false }: { primary?: boolean }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const me = useQuery(trpc.security.me.queryOptions());
  const [enrolOpen, setEnrolOpen] = React.useState(false);
  const [manage, setManage] = React.useState<ManageAction | null>(null);
  const refresh = (): void => void qc.invalidateQueries();

  if (!me.data) {
    return <CardSkeleton />;
  }
  const { enrolled, hasPassword } = me.data;

  return (
    <Section title="Authenticator app" hint="two-factor for password sign-ins" action={<StatusWord tone={enrolled ? 'ok' : 'idle'} word={enrolled ? 'On' : 'Off'} />}>
        <p className="text-muted-foreground text-sm">
          {enrolled
            ? 'Signing in with a password asks for a code from your authenticator app. Opening a terminal may ask again.'
            : 'Optional. Add a code from an authenticator app to your password sign-ins. Not needed if you sign in with SSO or a social account.'}
        </p>
        <div className="flex flex-wrap gap-2">
          {enrolled ? (
            <>
              <Button variant="outline" className="pointer-coarse:min-h-11" onClick={() => setManage('regenerate')}>
                New backup codes
              </Button>
              <Button variant="ghost" className="pointer-coarse:min-h-11" onClick={() => setManage('disable')}>
                Turn off
              </Button>
            </>
          ) : (
            <Button variant={primary ? 'default' : 'outline'} className="pointer-coarse:min-h-11" onClick={() => setEnrolOpen(true)}>
              Set up authenticator app
            </Button>
          )}
        </div>
        <Tech>TOTP · 6-digit codes · 30 s · 10 single-use backup codes · SSO sign-ins use your provider’s MFA</Tech>
      <EnrolTwoFactorDialog
        open={enrolOpen}
        onOpenChange={setEnrolOpen}
        hasPassword={hasPassword}
        onEnrolled={refresh}
      />
      <ManageTwoFactorDialog
        action={manage}
        onClose={() => setManage(null)}
        hasPassword={hasPassword}
        onChanged={refresh}
      />
    </Section>
  );
}
