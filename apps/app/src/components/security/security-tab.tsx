import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { MemberMfaList } from './member-mfa-list';
import { Require2faCard } from './require-2fa-card';
import { TerminalApprovalsCard } from './terminal-approvals-card';
import { TerminalPolicyCard } from './terminal-policy-card';
import { TwoFactorCard } from './two-factor-card';

/** Settings → Access → Security: your 2FA, and (admins) the org policies. */
export function SecurityTab(): React.JSX.Element {
  const trpc = useTRPC();
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  const isAdmin = org.data?.role === 'owner' || org.data?.role === 'admin';
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <div className="space-y-6">
        <TwoFactorCard />
        {isAdmin && <Require2faCard />}
      </div>
      {isAdmin && (
        <div className="space-y-6">
          <TerminalPolicyCard />
          <TerminalApprovalsCard />
          <MemberMfaList />
        </div>
      )}
    </div>
  );
}
