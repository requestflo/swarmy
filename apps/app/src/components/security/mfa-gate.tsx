import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { isDemo } from '@/demo/is-demo';
import { EnrolRequiredScreen, GraceBanner, MfaChallengeScreen } from './mfa-wall-screens';

/**
 * The dashboard side of the orgProcedure MFA wall. `security.me` is a
 * protectedProcedure, so it answers even while org calls are refused. A load
 * error never blocks: the server is the authority, this only explains it.
 */
export function MfaGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const trpc = useTRPC();
  const me = useQuery({
    ...trpc.security.me.queryOptions(),
    enabled: !isDemo(),
    refetchInterval: 60_000,
    retry: false,
  });
  const data = me.data;
  if (!data) return <>{children}</>;
  if (data.mfaPending) return <MfaChallengeScreen />;
  if (data.org?.standing === 'blocked') return <EnrolRequiredScreen />;
  if (data.org?.standing === 'grace') {
    return (
      <>
        <GraceBanner deadline={data.org.deadline ? new Date(data.org.deadline) : null} />
        {children}
      </>
    );
  }
  return <>{children}</>;
}
