import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheckIcon, ShieldIcon } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Skeleton, StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { EnrolTwoFactorDialog } from './enrol-two-factor-dialog';
import { ManageTwoFactorDialog, type ManageAction } from './manage-two-factor-dialog';

/** Your own authenticator-app 2FA: enrol, regenerate backup codes, disable. */
export function TwoFactorCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const me = useQuery(trpc.security.me.queryOptions());
  const [enrolOpen, setEnrolOpen] = React.useState(false);
  const [manage, setManage] = React.useState<ManageAction | null>(null);
  const refresh = (): void => void qc.invalidateQueries();

  if (!me.data) {
    return (
      <Card>
        <CardContent className="pt-6">
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }
  const { enrolled, hasPassword } = me.data;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          {enrolled ? <ShieldCheckIcon className="size-5" /> : <ShieldIcon className="size-5" />}
          Two-factor authentication
        </CardTitle>
        <StatusBadge tone={enrolled ? 'online' : 'neutral'} label={enrolled ? 'On' : 'Off'} />
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">
          {enrolled
            ? 'Signing in with a password asks for a code from your authenticator app. Opening a terminal may ask again.'
            : 'Add a code from an authenticator app to every sign-in. Needed to open terminals when your workspace requires recent MFA.'}
        </p>
        <div className="flex flex-wrap gap-2">
          {enrolled ? (
            <>
              <Button variant="outline" onClick={() => setManage('regenerate')}>
                New backup codes
              </Button>
              <Button variant="outline" onClick={() => setManage('disable')}>
                Turn off
              </Button>
            </>
          ) : (
            <Button onClick={() => setEnrolOpen(true)}>Set up authenticator app</Button>
          )}
        </div>
      </CardContent>
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
    </Card>
  );
}
